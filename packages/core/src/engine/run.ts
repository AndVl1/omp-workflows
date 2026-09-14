/**
 * Main interpreter loop. The class+method the `/team` slash command invokes.
 * It chains:
 *
 *   1. classify (model classification is authoritative when supplied)
 *   2. resolve workflow -> profile
 *   3. write state BEFORE any subagent launch
 *   4. walk profile stages
 *   5. mirror progress into team-state.md
 *
 * The `task` field of a `TaskCaller` is what the engine passes to the native
 * `task` tool / `agent` API. The engine itself does NOT use the model; it
 * orchestrates subagents only.
 *
 * Autonomy contract (RC2+): `classification.autonomous` is a routing/migration
 * input, authoritative only for the legacy workflow matrix. It NEVER grants
 * checkpoint permission; a checkpoint requires a policy-bound typed decision.
 * When the field is supplied, type/complexity/confidence/autonomous must all be
 * present — the engine FAILS CLOSED rather than silently filling the gaps from
 * keyword guesses.
 * `keywordClassify` remains only for legacy callers that run without a model
 * classification; it cannot decide autonomy (the caller's `autonomous` option
 * is used verbatim, never defaulted).
 */

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { loadAllProfiles, profileHash, resolveWorkflow, selectProfile } from "./profile.js";
import { resolveConfig, resolveAgentForRole, type ResolvedConfig } from "./config.js";
import { resolveScope, type ScopeFlags } from "./scope.js";
import { MAX_PERSISTED_STATE_BYTES, setStageStatus, setPause, normalizePersistedState, parseBoundedPersistedState, resolveState, resolveStatePinnedActive, resolvePreparationState, resolvePreparationStatePinned, reopenFromFeedback, updateStateAtomically, type ResolvedState } from "./state.js";
import {
  authorizeDispatch,
  authorizeDispatchFromPersisted,
  completeDispatch,
  completeDispatchFromPersisted,
  advanceCursor,
  advanceCursorFromPersisted,
  createCapability,
  validateStoppedImportedCheckpointBinding,
  type PersistedStagePostimage,
} from "./durable.js";
import { readArtifactPinned } from "./artifacts.js";
import { validateProducedArtifact } from "./artifact-contract.js";
import { checkpointDecisionEffect, selectLatestValidCheckpointDecision, validateCheckpointForAdvance } from "./checkpoints.js";
import { keywordClassify } from "./classify.js";
import type { Classification, Complexity, Confidence, DispatchSlot, Profile, RoleConfig, TaskType, TeamState, WorkflowName } from "./types.js";
import { walkProfile, resolveStageDispatchSlots, type StageContext, type TaskCaller } from "./stage.js";
import { dispatchTaskId } from "../gates/dispatch.js";
import { digestOf, isSafeFeatureId } from "../specification/validation.js";
import { featureStatePath, resolveFeatureWorkspace, stateCarriesSpecification, type WorkspaceRootSnapshot } from "../specification/workspace.js";
import { PinnedProjectRoot } from "../specification/pinned-root.js";
import { readPinnedCurrentConstitution } from "../specification/constitution-identities.js";
import { acquireDoWorkSpecClaim, type DoWorkSpecClaimAcquisition } from "../commands/do-work.js";
import { createPreparationHandoff as createUnsignedPreparationHandoff, newPreparationToken, preparationStateDigest, verifyPreparationHandoffDigest, type PreparationRootIdentity, type WorkflowPreparationHandoff } from "./preparation.js";

/**
 * The model's PHASE-0 classification. `type`, `complexity`, `confidence` and
 * `autonomous` are classified together by the LLM and are all required;
 * `workflow` may be omitted and is then resolved from the matrix.
 */
export interface ModelClassification {
  type: TaskType;
  complexity: Complexity;
  confidence: Confidence;
  autonomous: boolean;
  /** Model's justification for the autonomy decision (optional). */
  autonomous_reason?: string;
  /** Explicit workflow override; resolved from the matrix when absent. */
  workflow?: WorkflowName;
}

export interface RunOptions {
  task: string;
  cwd: string;
  branch: string;
  /** Legacy autonomy flag for callers without model classification. */
  autonomous: boolean;
  /** Authoritative model classification (PHASE-0). */
  classification?: ModelClassification;
  /** Caller-issued task tool reference. */
  taskTool: TaskCaller;
  /** Repository paths used for conditional scope and roster resolution. */
  files?: string[];
  /** Execute an inline orchestrator stage in the owning main session. */
  orchestrate?: NonNullable<StageContext["orchestrate"]>;
  issue?: { number: number; url?: string } | null;
  pause?: (reason: string) => Promise<void>;
  log?: (line: string) => void;
  /** Resume prior state after user feedback, preserving artifacts/history. */
  continuation?: { feedback: string; stageId: string };
  /**
   * Explicit specification selectors (T013). Both are mandatory together and
   * never inferred: a continuation whose state carries a specification
   * aggregate rejects without them, and a provided run_key must match the
   * persisted engine run binding exactly.
   */
  feature_id?: string;
  run_key?: string;
  /** Borrowed root for the public run lifecycle; never opened or closed by nested stages. */
  pinnedRoot?: PinnedProjectRoot;
}

export interface RunResult {
  classification: Classification;
  profile: Profile;
  outcomes: Array<{ stageId: string; status: "done" | "skipped" | "failed"; note: string }>;
  statePath: string | null;
}

export type ImplementationWorkflowBeginAdmission =
  | { ok: true; required: false }
  | { ok: true; required: true; claim: DoWorkSpecClaimAcquisition & { ok: true } }
  | { ok: false; code: "SPEC_IMPLEMENTATION_CLAIM_REQUIRED" | "SPEC_STATE_INVALID"; error: string };

/** Internal deterministic seam for the claim-to-capability crash boundary. */
export interface ImplementationWorkflowBeginTestHooks {
  afterClaim?: () => void;
}
let implementationWorkflowBeginTestHooks: ImplementationWorkflowBeginTestHooks | null = null;
/** Test-only hook; intentionally not exported by the package index. */
export function setImplementationWorkflowBeginTestHooks(hooks: ImplementationWorkflowBeginTestHooks | null): void {
  implementationWorkflowBeginTestHooks = hooks;
}
export function invokeImplementationWorkflowBeginTestHook(): void {
  implementationWorkflowBeginTestHooks?.afterClaim?.();
}

/**
 * Mechanically admit implementation workflow_begin for a specification-backed
 * state. Identity is read from the exact pinned TeamState; caller text cannot
 * supply a handoff digest or owner identity. The claim helper repeats the
 * selector/preimage checks atomically before binding the workspace claim.
 */
export async function admitImplementationWorkflowBegin(
  projectRoot: string,
  input: { feature_id?: string; run_key?: string },
): Promise<ImplementationWorkflowBeginAdmission> {
  if (!input.feature_id && !input.run_key) return { ok: true, required: false };
  if (typeof input.feature_id !== "string" || typeof input.run_key !== "string" || !isSafeFeatureId(input.feature_id) || input.run_key.trim().length === 0) {
    return { ok: false, code: "SPEC_IMPLEMENTATION_CLAIM_REQUIRED", error: "exact feature_id and run_key selectors are required before implementation admission" };
  }
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, code: "SPEC_STATE_INVALID", error: "project root cannot be pinned for implementation admission" };
  try {
    const relativePath = pinnedRoot.relativePath(featureStatePath(pinnedRoot.canonical_root, input.feature_id));
    if (!relativePath) return { ok: false, code: "SPEC_STATE_INVALID", error: "feature state path escapes the pinned project root" };
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_STATE_INVALID", error: "project root changed before implementation state read" };
    let parsed: unknown;
    try {
      const readResult = pinnedRoot.readFile(relativePath, { maxBytes: MAX_PERSISTED_STATE_BYTES });
      const identity = pinnedRoot.pathEntryInfo(relativePath);
      if (
        !pinnedRoot.isStable()
        || identity === null
        || identity.kind !== "file"
        || identity.dev !== readResult.dev
        || identity.ino !== readResult.ino
      ) {
        throw new Error("feature state path changed after implementation state read");
      }
      const rawText = new TextDecoder("utf-8", { fatal: true }).decode(readResult.bytes);
      parsed = JSON.parse(rawText);
    } catch (error) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: `feature state is unreadable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const bounded = parseBoundedPersistedState(parsed);
    if (!bounded) return { ok: false, code: "SPEC_STATE_INVALID", error: "feature state exceeds bounded structural limits or has an unsafe object shape" };
    const stateRevision = (bounded as Record<string, unknown>).state_revision;
    if (!Number.isSafeInteger(stateRevision) || (stateRevision as number) < 0) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "feature state revision is missing or invalid" };
    }
    const issues: string[] = [];
    const state = normalizePersistedState(bounded, issues, { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino });
    if (!state) return { ok: false, code: "SPEC_STATE_INVALID", error: `feature state is invalid${issues.length ? `: ${issues.join("; ")}` : ""}` };
    if ((state as TeamState & { state_revision?: unknown }).state_revision !== stateRevision) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "feature state revision changed during normalization" };
    }
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_STATE_INVALID", error: "project root changed before implementation claim admission" };
    if (state.run_key !== input.run_key || state.specification?.feature_id !== input.feature_id) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "explicit selector does not match the pinned persisted specification state" };
    }
    if (!stateCarriesSpecification(state)) return { ok: true, required: false };
    const status = state.specification.status;
    if (status !== "implementation_ready" && status !== "claimed" && status !== "executing") return { ok: true, required: false };
    const acquired = await acquireDoWorkSpecClaim(pinnedRoot.canonical_root, {
      feature_id: state.specification.feature_id,
      run_key: state.run_key,
      owner_run_id: state.run_key,
    }, pinnedRoot, invokeImplementationWorkflowBeginTestHook);
    if (!acquired.ok) return { ok: false, code: acquired.code === "SPEC_EXECUTION_CLAIMED" ? "SPEC_IMPLEMENTATION_CLAIM_REQUIRED" : "SPEC_STATE_INVALID", error: acquired.error };
    return { ok: true, required: true, claim: acquired };
  } finally {
    pinnedRoot.close();
  }
}

/** Resolve the registered profile bound to an exact specification workspace seed. */
function specificationSeedProfile(profiles: Profile[], state: TeamState | null): Profile {
  const specification = state?.specification;
  if (!specification || state?.classification) throw new Error("specification workspace seed is missing its specification aggregate");
  const expectedName = specification.source_kind === "external" ? "spec-import" : "spec-preparation";
  const profile = profiles.find((candidate) => candidate.name === specification.profile_name && profileHash(candidate) === specification.profile_hash);
  if (!profile) throw new Error("specification workspace profile is unavailable or its hash does not match a registered profile");
  if (profile.name !== expectedName) throw new Error("specification workspace source_kind " + specification.source_kind + " must use registered profile " + expectedName);
  return profile;
}

type SpecificationImportSeedCheck = {
  ok: true;
  profile: Profile;
  stopped: boolean;
  resumed: boolean;
} | {
  ok: false;
  candidate: boolean;
  error: string;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Validate the command-owned deterministic import projection before allowing
 * workflow_prepare to reopen it. A full seed is not an ordinary prepared run:
 * its profile, workspace identity, fixed artifacts, completed deterministic
 * stages, and approval cursor must all agree exactly. Any malformed candidate
 * fails closed rather than falling back to a reset/pending workflow.
 */
function specificationImportSeed(
  state: TeamState,
  profiles: Profile[],
  artifactsDir: string | undefined,
  expected: { branch: string; featureId: string; runKey: string },
  options: { allowStopped?: boolean; pinnedRoot?: PinnedProjectRoot } = {},
): SpecificationImportSeedCheck {
  const candidate = state.classification?.workflow === "spec-import"
    || (state.classification !== undefined && state.specification?.source_kind === "external")
    || (state.stage_cursor === "compatibility_approval" && state.specification?.source_kind === "external");
  if (!candidate) return { ok: false, candidate: false, error: "not a specification import seed" };
  if (!artifactsDir) return { ok: false, candidate: true, error: "specification import seed artifact directory is unavailable" };
  const specification = state.specification;
  if (!specification || specification.source_kind !== "external") return { ok: false, candidate: true, error: "specification import seed requires an external workspace" };
  if (specification.feature_id !== expected.featureId || state.run_key !== expected.runKey) return { ok: false, candidate: true, error: "specification import seed selectors do not match the workspace" };
  if (state.branch !== expected.branch) return { ok: false, candidate: true, error: "specification import seed branch does not match the active branch" };
  const profile = profiles.find((entry) => entry.name === specification.profile_name && profileHash(entry) === specification.profile_hash);
  if (!profile || profile.name !== "spec-import") return { ok: false, candidate: true, error: "specification import seed profile is unavailable or stale" };
  if (!state.classification
    || state.classification.type !== "SPEC"
    || state.classification.complexity !== "MEDIUM"
    || state.classification.confidence !== "HIGH"
    || state.classification.autonomous !== false
    || state.classification.workflow !== "spec-import") {
    return { ok: false, candidate: true, error: "specification import seed classification is not the canonical non-autonomous SPEC import" };
  }
  if (state.task !== "Read-only external specification compatibility validation"
    || state.workflow_override !== true
    || state.issue !== null
    || (!options.allowStopped && state.pause.kind !== "none")
    || state.policy?.strict_orchestrator !== true) {
    return { ok: false, candidate: true, error: "specification import seed control fields are not canonical" };
  }
  const artifactDirectoryRelative = options.pinnedRoot?.relativePath(artifactsDir);
  if (options.pinnedRoot && artifactDirectoryRelative === null) {
    return { ok: false, candidate: true, error: "specification import seed artifacts escape the pinned project root" };
  }
  if (!options.pinnedRoot || artifactDirectoryRelative === null || artifactDirectoryRelative === undefined) {
    return { ok: false, candidate: true, error: "specification import seed reads require a pinned project root" };
  }
  const snapshot = readArtifactPinned(options.pinnedRoot, artifactDirectoryRelative, "import_snapshot");
  const report = readArtifactPinned(options.pinnedRoot, artifactDirectoryRelative, "compatibility_report");
  const snapshotCheck = validateProducedArtifact("import_snapshot", snapshot);
  if (!snapshotCheck.ok) return { ok: false, candidate: true, error: "specification import seed import_snapshot artifact is invalid" };
  const reportCheck = validateProducedArtifact("compatibility_report", report);
  if (!reportCheck.ok) return { ok: false, candidate: true, error: "specification import seed compatibility_report artifact is invalid" };
  const snapshotRecord = objectRecord(snapshot);
  const reportRecord = objectRecord(report);
  const binding = objectRecord(specification.constitution_binding);
  const reportBinding = reportRecord ? objectRecord(reportRecord.constitution_binding) : null;
  const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  const sortedPaths = (value: unknown): unknown[] =>
    Array.isArray(value) ? [...value].sort((left, right) => String(left).localeCompare(String(right), "en")) : [];
  const sortedIgnored = (value: unknown): unknown[] =>
    Array.isArray(value)
      ? [...value].sort((left, right) => {
        const a = objectRecord(left);
        const b = objectRecord(right);
        return String(a?.path).localeCompare(String(b?.path), "en") || String(a?.reason).localeCompare(String(b?.reason), "en");
      })
      : [];
  let expectedSnapshotId: string | null = null;
  let expectedReportId: string | null = null;
  let sourceRootWithinWorkspace = false;
  let workspaceProvenanceMatches = false;
  if (snapshotRecord && reportRecord && binding && reportBinding) {
    const selectorIdentity = {
      feature: expected.featureId,
      run: expected.runKey,
      feature_source: "explicit" as const,
      run_source: "explicit" as const,
    };
    const selectorBinding = {
      ...selectorIdentity,
      binding_hash: digestOf(selectorIdentity),
    };
    const selectedPaths = sortedPaths(snapshotRecord.selected_paths);
    const ignoredCandidates = sortedIgnored(snapshotRecord.ignored_candidates);
    expectedSnapshotId = `import.${digestOf({
      schema_version: 1,
      source_root: snapshotRecord.source_root,
      source_root_identity: snapshotRecord.source_root_identity,
      limits: snapshotRecord.limits,
      intake_paths: snapshotRecord.intake_paths,
      files: snapshotRecord.files,
      source_revision: snapshotRecord.source_revision,
      document_language: snapshotRecord.document_language,
      document_language_source: snapshotRecord.document_language_source,
      selector_binding: selectorBinding,
      framework: snapshotRecord.framework,
      mapping_id: snapshotRecord.mapping_id,
      mapping_version: snapshotRecord.mapping_version,
      selected_paths: selectedPaths,
      ignored_candidates: ignoredCandidates,
    })}`;
    expectedReportId = `compatibility.${digestOf({
      snapshot_ref: reportRecord.snapshot_ref,
      constitution_hash: reportBinding.content_sha256,
      document_language: reportRecord.document_language,
      document_language_source: reportRecord.document_language_source,
      status: reportRecord.status,
      framework: reportRecord.framework,
      mapping_id: reportRecord.mapping_id,
      mapping_version: reportRecord.mapping_version,
      selected_paths: reportRecord.selected_paths,
      mapping: reportRecord.mapping,
      blocking_findings: reportRecord.blocking_findings,
      ignored_content: reportRecord.ignored_content,
    })}`;
    const workspaceRoot = resolvePath(artifactsDir, "../../../..");
    const sourceRoot = typeof snapshotRecord.source_root === "string" ? snapshotRecord.source_root : "";
    sourceRootWithinWorkspace = sourceRoot === workspaceRoot || sourceRoot.startsWith(`${workspaceRoot}/`);
    workspaceProvenanceMatches = specification.project_root === workspaceRoot
      && specification.workspace_path === `specs/${expected.featureId}`
      && specification.state_path === `.work-state/features/${expected.featureId}/state.json`
      && sourceRootWithinWorkspace;
  }
  if (!snapshotRecord || !reportRecord || !binding || !reportBinding
    || snapshotRecord.snapshot_id !== specification.import_ref
    || snapshotRecord.snapshot_id !== expectedSnapshotId
    || reportRecord.report_id !== expectedReportId
    || reportRecord.snapshot_ref !== snapshotRecord.snapshot_id
    || reportRecord.status !== "ready"
    || reportRecord.framework !== snapshotRecord.framework
    || reportRecord.document_language !== snapshotRecord.document_language
    || reportRecord.document_language_source !== snapshotRecord.document_language_source
    || reportRecord.mapping_id !== snapshotRecord.mapping_id
    || reportRecord.mapping_version !== snapshotRecord.mapping_version
    || !sameJson(reportRecord.selected_paths, snapshotRecord.selected_paths)
    || !sameJson(reportRecord.ignored_content, snapshotRecord.ignored_candidates)
    || !sameJson(reportRecord.selected_paths, sortedPaths(reportRecord.selected_paths))
    || !sameJson(reportRecord.ignored_content, sortedIgnored(reportRecord.ignored_content))
    || digestOf(reportBinding) !== digestOf(binding)
    || !workspaceProvenanceMatches) {
    return { ok: false, candidate: true, error: "specification import seed artifacts are not bound to the workspace snapshot, source, and constitution" };
  }
  const approvalStage = profile.stages.find((stage) => stage.id === "compatibility_approval");
  const latestDecision = approvalStage
    ? selectLatestValidCheckpointDecision(approvalStage, state, { bindCapability: false })
    : null;
  const hasStopDecision = Boolean(
    latestDecision?.ok
    && latestDecision.decision
    && checkpointDecisionEffect(latestDecision.decision) === "stop",
  );
  const stopped = Boolean(options.allowStopped && state.pause.kind === "done" && hasStopDecision);
  const expectedApprovalStages = profile.stages.map((stage) => {
    if (stage.id === "import" || stage.id === "constitution" || stage.id === "compatibility") return { id: stage.id, status: "done" as const };
    if (stage.id === "compatibility_approval") return { id: stage.id, status: "done" as const };
    return { id: stage.id, status: "pending" as const };
  });
  const expectedSeedStages = profile.stages.map((stage) => {
    if (stage.id === "import" || stage.id === "constitution" || stage.id === "compatibility") return { id: stage.id, status: "done" as const };
    if (stage.id === "compatibility_approval") return { id: stage.id, status: "in_progress" as const };
    return { id: stage.id, status: "pending" as const };
  });
  const expectedResumedStages = profile.stages.map((stage) => {
    if (stage.id === "import" || stage.id === "constitution" || stage.id === "compatibility" || stage.id === "compatibility_approval") return { id: stage.id, status: "done" as const };
    if (stage.id === "handoff") return { id: stage.id, status: "in_progress" as const };
    return { id: stage.id, status: "pending" as const };
  });
  const resumed = Boolean(
    options.allowStopped
    && hasStopDecision
    && state.pause.kind === "none"
    && state.stage_cursor === "handoff"
    && JSON.stringify(state.stages) === JSON.stringify(expectedResumedStages)
    && specification.status === "in_progress"
    && specification.handoff_ref === null
    && (specification.next_action.kind === "none" || specification.next_action.kind === "checkpoint")
    && specification.next_action.command === null,
  );
  const positioned = stopped
    ? state.stage_cursor === "compatibility_approval"
      && JSON.stringify(state.stages) === JSON.stringify(expectedApprovalStages)
      && specification.status === "in_progress"
      && specification.handoff_ref === null
      && (specification.next_action.kind === "none" || specification.next_action.kind === "checkpoint")
      && specification.next_action.command === null
    : resumed
      ? true
      : state.stage_cursor === "compatibility_approval"
        && JSON.stringify(state.stages) === JSON.stringify(expectedSeedStages)
        && specification.status === "in_progress"
        && specification.next_action.kind === "checkpoint"
        && specification.next_action.command === null;
  if (!positioned) {
    return { ok: false, candidate: true, error: "specification import seed is not positioned at its sole compatibility approval stage" };
  }
  return { ok: true, profile, stopped, resumed };
}
function resumeStoppedImportState(
  state: TeamState,
  profile: Profile,
): { ok: true; state: TeamState } | { ok: false; error: string } {
  const currentCapability = state.dispatch_capability;
  const issuedFor = currentCapability?.issued_for;
  const handoffStage = profile.stages.find((stage) => stage.id === "handoff");
  if (
    !handoffStage
    || handoffStage.type !== "orchestrator"
    || !currentCapability
    || currentCapability.status !== "complete"
    || !issuedFor
    || typeof issuedFor.run_key !== "string"
    || typeof issuedFor.branch !== "string"
    || typeof issuedFor.workflow !== "string"
    || typeof issuedFor.profile_hash !== "string"
    || typeof issuedFor.stage_cursor !== "string"
    || issuedFor.stage_cursor !== "compatibility_approval"
  ) {
    return { ok: false, error: "stopped import approval does not have an exact terminal capability boundary" };
  }
  const issued = createCapability({
    run_key: issuedFor.run_key,
    branch: issuedFor.branch,
    workflow: issuedFor.workflow,
    profile_hash: issuedFor.profile_hash,
    stage_cursor: handoffStage.id,
    kind: "none",
    expected_roster: [],
  });
  const epoch = issued.state.issued_for?.cursor_epoch;
  if (!epoch) return { ok: false, error: "stopped import resume capability epoch is unavailable" };
  const resumed: TeamState = {
    ...state,
    stage_cursor: handoffStage.id,
    cursor_epoch: epoch,
    dispatch_capability: issued.state,
    stages: state.stages.map((stage) => stage.id === handoffStage.id
      ? { ...stage, status: "in_progress" as const }
      : stage),
    specification: state.specification
      ? {
        ...state.specification,
        status: "in_progress",
        handoff_ref: null,
        next_action: {
          kind: "none",
          command: null,
          reason: "Compatibility approval was explicitly resumed; finalize the imported implementation handoff before execution.",
        },
      }
      : state.specification,
    pause: { kind: "none", reason: "" },
    history: [
      ...(state.history ?? []),
      {
        task: state.task,
        feedback: "Explicitly resumed external import after approve_stop; the handoff finalizer stage was armed.",
        at: new Date().toISOString(),
      },
    ],
    updated_at: new Date().toISOString(),
  };
  return { ok: true, state: resumed };
}


export interface SpecificationImportSeedOptions {
  cwd: string;
  branch: string;
  feature_id: string;
  run_key: string;
  /** Borrowed descriptor pin; the caller retains ownership and closes it. */
  pinned_root?: PinnedProjectRoot;
  /** Borrowed workspace snapshot; its descriptor is also caller-owned. */
  root_snapshot?: WorkspaceRootSnapshot;
}

/** Persist the command's deterministic import/compatibility result as a
 * trusted engine seed. Repeated calls are idempotent; mismatched/tampered
 * state or artifacts are rejected without resetting an existing workflow. */
export function seedSpecificationImportWorkflowState(opts: SpecificationImportSeedOptions): { ok: true; state: TeamState } | { ok: false; error: string } {
  if (!isSafeFeatureId(opts.feature_id) || opts.run_key.trim() === "") return { ok: false, error: "specification import seed selectors are invalid" };
  const profiles = loadAllProfiles();
  const profile = profiles.find((entry) => entry.name === "spec-import");
  if (!profile) return { ok: false, error: "the shipped spec-import profile is unavailable" };
  const borrowedRoot = opts.pinned_root ?? opts.root_snapshot?.pinned_root;
  const config = resolveConfig(opts.cwd, {}, borrowedRoot);
  if (opts.root_snapshot && opts.pinned_root
    && (opts.root_snapshot.pinned_root !== opts.pinned_root
      || opts.root_snapshot.canonical_root !== opts.pinned_root.canonical_root
      || opts.root_snapshot.dev !== opts.pinned_root.dev
      || opts.root_snapshot.ino !== opts.pinned_root.ino)) {
    return { ok: false, error: "specification import seed received mismatched borrowed root descriptors" };
  }
  const flags = resolveScope([], config);
  let seedGuardState: TeamState | null = null;
  const result = updateStateAtomically<TeamState>(opts.cwd, (snapshot) => {
    const current = snapshot.state;
    seedGuardState = current;
    if (!current || !current.specification) return { op: "fail", code: "state_missing", error: "specification import workspace state is missing" };
    if (current.classification) {
      const replay = specificationImportSeed(
        current,
        profiles,
        snapshot.target.artifactsDir ?? undefined,
        { branch: opts.branch, featureId: opts.feature_id, runKey: opts.run_key },
        { allowStopped: true, ...(borrowedRoot ? { pinnedRoot: borrowedRoot } : {}) },
      );
      if (!replay.ok) return { op: "fail", code: "state_conflict", error: replay.error };
      const approvalStage = replay.profile.stages.find((stage) => stage.id === "compatibility_approval");
      const selected = approvalStage ? selectLatestValidCheckpointDecision(approvalStage, current, { bindCapability: false }) : null;
      if (replay.stopped || replay.resumed) {
        if (!approvalStage || !selected?.ok || !selected.decision) {
          return { op: "fail", code: "state_conflict", error: "stopped import approval decision is unavailable during explicit resume" };
        }
        const subject = validateStoppedImportedCheckpointBinding(opts.cwd, current, snapshot.target, approvalStage, selected.decision);
        if (!subject.ok) return { op: "fail", code: "state_conflict", error: subject.error };
      }
      if (replay.resumed) {
        if (current.specification.next_action.kind === "none") return { op: "discard", value: current };
        const normalized: TeamState = {
          ...current,
          specification: {
            ...current.specification,
            next_action: {
              kind: "none",
              command: null,
              reason: "Compatibility approval was explicitly resumed; finalize the imported implementation handoff before execution.",
            },
          },
        };
        return { op: "commit", state: normalized, value: normalized };
      }
      if (!replay.stopped) return { op: "discard", value: current };
      const resumed = resumeStoppedImportState(current, replay.profile);
      if (!resumed.ok) return { op: "fail", code: "state_conflict", error: resumed.error };
      return { op: "commit", state: resumed.state, value: resumed.state };
    }
    const workspace = current.specification;
    if (workspace.source_kind !== "external" || workspace.feature_id !== opts.feature_id || workspace.profile_name !== "spec-import" || workspace.profile_hash !== profileHash(profile)) {
      return { op: "fail", code: "state_conflict", error: "workspace is not the exact external spec-import profile seed" };
    }
    const artifactsDir = snapshot.target.artifactsDir;
    if (!artifactsDir) return { op: "fail", code: "state_invalid", error: "specification import seed artifact directory is unavailable" };
    const artifactsDirRelative = borrowedRoot?.relativePath(artifactsDir);
    if (borrowedRoot && artifactsDirRelative === null) return { op: "fail", code: "state_invalid", error: "specification import seed artifacts escape the pinned project root" };
    if (!borrowedRoot || artifactsDirRelative === null || artifactsDirRelative === undefined) {
      return { op: "fail", code: "state_invalid", error: "deterministic import artifact reads require a pinned project root" };
    }
    const snapshotArtifact = readArtifactPinned(borrowedRoot, artifactsDirRelative, "import_snapshot");
    const reportArtifact = readArtifactPinned(borrowedRoot, artifactsDirRelative, "compatibility_report");
    const snapshotCheck = validateProducedArtifact("import_snapshot", snapshotArtifact);
    const reportCheck = validateProducedArtifact("compatibility_report", reportArtifact);
    if (!snapshotCheck.ok || !reportCheck.ok) return { op: "fail", code: "state_invalid", error: "deterministic import artifacts are missing or invalid" };
    const snapshotRecord = objectRecord(snapshotArtifact);
    const reportRecord = objectRecord(reportArtifact);
    const binding = objectRecord(workspace.constitution_binding);
    const reportBinding = reportRecord ? objectRecord(reportRecord.constitution_binding) : null;
    if (!snapshotRecord || !reportRecord || !binding || !reportBinding
      || snapshotRecord.snapshot_id !== workspace.import_ref
      || reportRecord.snapshot_ref !== snapshotRecord.snapshot_id
      || reportRecord.status !== "ready"
      || digestOf(reportBinding) !== digestOf(binding)) {
      return { op: "fail", code: "state_invalid", error: "deterministic import artifacts are not bound to the workspace" };
    }
    const stages = profile.stages.map((stage) => ({
      id: stage.id,
      status: stage.id === "import" || stage.id === "constitution" || stage.id === "compatibility" ? "done" as const : stage.id === "compatibility_approval" ? "in_progress" as const : "pending" as const,
    }));
    const seeded: TeamState = {
      schema: 1,
      branch: opts.branch,
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "spec-import" },
      task: "Read-only external specification compatibility validation",
      workflow_override: true,
      issue: null,
      stage_cursor: "compatibility_approval",
      stages,
      artifacts: {},
      pause: { kind: "none", reason: "" },
      updated_at: new Date().toISOString(),
      policy: { strict_orchestrator: true },
      scope: flags,
      profile_hash: profileHash(profile),
      run_key: opts.run_key,
      specification: workspace,
    };
    const checked = specificationImportSeed(seeded, profiles, artifactsDir, { branch: opts.branch, featureId: opts.feature_id, runKey: opts.run_key }, borrowedRoot ? { pinnedRoot: borrowedRoot } : undefined);
    if (!checked.ok) return { op: "fail", code: "state_invalid", error: checked.error };
    seedGuardState = seeded;
    return { op: "commit", state: seeded, value: seeded };
  }, { selector: { feature_id: opts.feature_id, run_key: opts.run_key }, branch: opts.branch, branchNeutral: true, ...(borrowedRoot ? { pinnedRoot: borrowedRoot } : {}), preCommit: () => strictRunConstitutionGuard(opts.cwd, borrowedRoot, seedGuardState) });
  if (!result.ok) return { ok: false, error: result.error };
  return result.state ? { ok: true, state: result.state } : { ok: false, error: "specification import seed could not be persisted" };
}

/**
 * Resolve the authoritative classification: model first (fail closed on
 * incomplete output), keyword guess only for legacy callers.
 */
export function resolveClassification(opts: Pick<RunOptions, "task" | "autonomous" | "classification">, specificationProfileName?: string): Classification {
  const model = opts.classification;
  if (model) {
    if (!model.type || !model.complexity || !model.confidence || typeof model.autonomous !== "boolean") {
      throw new Error(
        `classification gate: model classification incomplete (type=${model.type}, complexity=${model.complexity}, confidence=${model.confidence}, autonomous=${model.autonomous}). PHASE-0 must classify type, complexity, confidence and autonomous together; refusing to fall back to keyword guesses.`,
      );
    }
    if (model.type === "PRODUCT_DISCOVERY" && model.autonomous) {
      throw new Error(
        "classification gate: PRODUCT_DISCOVERY is always human-approved; autonomous product discovery fails closed (reclassify with autonomous=false, the product_approval checkpoint is interactive-only)",
      );
    }
    const expected = resolveWorkflow(model.type, model.complexity, model.autonomous);
    if (specificationProfileName !== undefined) {
      if (model.type !== "SPEC") throw new Error("classification gate: a specification workspace seed requires type SPEC");
      if (model.workflow !== specificationProfileName) throw new Error("classification gate: seeded SPEC workspace requires workflow " + specificationProfileName + ", got " + (model.workflow ?? expected));
    } else if (model.workflow !== undefined && model.workflow !== expected && (model.type === "SPEC" || model.type === "REGRESS" || model.type === "LECTURE_RESEARCH" || model.type === "PRODUCT_DISCOVERY")) {
      throw new Error("classification gate: " + model.type + " must resolve to '" + expected + "', got '" + model.workflow + "'");
    }
    return {
      type: model.type,
      complexity: model.complexity,
      confidence: model.confidence,
      autonomous: model.autonomous,
      autonomous_reason: model.autonomous_reason,
      workflow: model.workflow ?? expected,
    };
  }
  // Legacy path: keyword guess for type/complexity/confidence only; the
  // caller's explicit autonomous flag is used verbatim — never defaulted.
  const base = keywordClassify(opts.task);
  if (base.type === "PRODUCT_DISCOVERY" && opts.autonomous) {
    throw new Error(
      "classification gate: PRODUCT_DISCOVERY is always human-approved; autonomous product discovery fails closed (reclassify with autonomous=false, the product_approval checkpoint is interactive-only)",
    );
  }
  return {
    type: base.type,
    complexity: base.complexity,
    confidence: base.confidence,
    autonomous: opts.autonomous,
    workflow: resolveWorkflow(base.type, base.complexity, opts.autonomous),
  };
}

export type WorkflowPrepareOptions = Pick<RunOptions, "task" | "cwd" | "branch" | "autonomous" | "classification" | "files" | "issue" | "continuation" | "feature_id" | "run_key"> & {
  /** Adaptive QUICK runs use the legacy root state, never a feature workspace. */
  adaptiveQuick?: boolean;
  /** Optional borrowed root for an explicit, descriptor-relative migration. */
  pinnedRoot?: PinnedProjectRoot;
};

export interface PreparedWorkflowState {
  config: ResolvedConfig;
  profile: Profile;
  flags: ScopeFlags;
  classification: Classification;
  state: TeamState;
  statePath: string;
  artifactsDir: string;
  stateTarget: { target?: ResolvedState; featureSlug?: string };
  expectedRoster: (stage: NonNullable<Profile["stages"][number]>) => Array<{ role: string; agent: string }>;
  preparation_handoff?: WorkflowPreparationHandoff;
}

/**
 * Persist a new PHASE-0 classification through the engine-owned state writer.
 * The interactive orchestrator must call this helper through `workflow_prepare`
 * instead of editing canonical `.work-state` files directly.
 */
function canonicalReplayValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReplayValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["updated_at", "state_revision", "observability", "migration", "control_plane_provenance", "completion_intent", "checkpoint_policy", "roster_policy", "work_identity"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalReplayValue(item)]));
  }
  return value;
}

function exactPreparationReplay(left: TeamState, right: TeamState): boolean {
  return JSON.stringify(canonicalReplayValue(left)) === JSON.stringify(canonicalReplayValue(right));
}

function exactNativeContinuationReplay(
  state: TeamState,
  continuation: NonNullable<WorkflowPrepareOptions["continuation"]>,
  featureId: string,
  runKey: string,
): boolean {
  const history = state.history ?? [];
  const latest = history.at(-1);
  const handoff = state.preparation_handoff;
  const revision = state.state_revision;
  if (!latest || latest.feedback !== continuation.feedback || latest.task.length === 0
    || state.stage_cursor !== continuation.stageId
    || state.branch.length === 0
    || state.run_key !== runKey
    || state.specification?.feature_id !== featureId
    || state.task !== latest.task
    || !handoff
    || handoff.feature_id !== featureId
    || handoff.run_key !== runKey
    || handoff.branch !== state.branch
    || handoff.task !== state.task
    || !Number.isSafeInteger(revision)
    || handoff.state_revision !== revision
    || handoff.state_digest !== preparationStateDigest(state, revision as number)
    || !verifyPreparationHandoffDigest(handoff)
    || state.preparation_start !== undefined) return false;
  return true;
}

function preparationHandoffMatchesCurrentPostimage(state: TeamState): boolean {
  const handoff = state.preparation_handoff;
  const revision = state.state_revision;
  return Boolean(
    handoff
    && Number.isSafeInteger(revision)
    && (revision as number) >= 1
    && handoff.state_revision === revision
    && handoff.state_digest === preparationStateDigest(state, revision as number)
    && verifyPreparationHandoffDigest(handoff),
  );
}

function preparationRefreshHasActiveWork(state: TeamState): boolean {
  if (state.preparation_start !== undefined) return true;
  const capability = state.dispatch_capability;
  if (capability) {
    if (capability.status === "dispatched" || capability.status === "joining") return true;
    if (capability.status !== "ready" && capability.status !== "complete" && capability.status !== "invalidated") return true;
    if ((capability.dispatches?.length ?? 0) > 0) return true;
    if ((capability.pending?.length ?? 0) > 0) return true;
  }
  const pending = state.pending === undefined ? [] : Array.isArray(state.pending) ? state.pending : [state.pending];
  if (pending.some((entry) => entry.status === "authorized" || entry.status === "running" || entry.status === "pending")) return true;
  return state.child_join !== undefined && (state.child_join.state === "authorized" || state.child_join.state === "pending");
}

function nativePreparationTransitionEvidence(state: TeamState, profiles: readonly Profile[]): boolean {
  const workspace = state.specification;
  const classification = state.classification;
  const revision = state.state_revision;
  if (!workspace || workspace.source_kind !== "native" || classification.workflow !== "spec-preparation"
    || !Number.isSafeInteger(revision) || (revision as number) < 1) return false;
  const profile = profiles.find((candidate) => candidate.name === classification.workflow);
  if (!profile) return false;
  const nativePhases = new Set(["specify", "plan", "tasks"]);
  const currentIndex = profile.stages.findIndex((stage) => stage.id === state.stage_cursor);
  const currentStage = currentIndex < 0 ? undefined : profile.stages[currentIndex];
  const currentRecord = workspace.phases.find((phase) => phase.phase === state.stage_cursor);
  const stateStage = state.stages.find((stage) => stage.id === state.stage_cursor);
  if (!currentStage || !currentStage.roster_policy || !currentStage.checkpoint
    || !nativePhases.has(currentStage.id) || currentStage.checkpoint !== "specification_phase_approval"
    || !currentRecord || !stateStage || !["pending", "in_progress", "done"].includes(stateStage.status)
    || workspace.status !== "in_progress" || workspace.handoff_ref !== null) return false;
  const transitionDecision = (phase: string) => {
    const stage = profile.stages.find((candidate) => candidate.id === phase);
    if (!stage?.checkpoint) return undefined;
    const selected = selectLatestValidCheckpointDecision({ id: phase, checkpoint: stage.checkpoint }, state, { bindCapability: false });
    if (!selected.ok || !selected.decision) return undefined;
    const decision = selected.decision;
    const typed = state.typed_checkpoint_decisions?.some((candidate) =>
      candidate.stage_id === decision.stage_id
      && candidate.checkpoint_id === decision.checkpoint_id
      && candidate.decided_at === decision.decided_at
      && candidate.actor.proof?.answer_id === decision.actor.proof?.answer_id,
    );
    const answerId = decision.actor.proof?.answer_id;
    const answer = answerId ? state.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === answerId) : undefined;
    if (!typed || !answer || !answer.consumed_at
      || answer.run_id !== state.run_key
      || answer.stage_id !== phase
      || answer.checkpoint_id !== stage.checkpoint
      || answer.feature_id !== workspace.feature_id
      || !Number.isSafeInteger(answer.subject_revision)
      || (answer.subject_revision as number) >= (revision as number)
      || decision.run_id !== state.run_key
      || decision.feature_id !== workspace.feature_id) return undefined;
    return decision;
  };
  const priorNativeStage = currentIndex > 0
    ? profile.stages.slice(0, currentIndex).reverse().find((stage) => nativePhases.has(stage.id) && stage.roster_policy && stage.checkpoint === "specification_phase_approval")
    : undefined;
  if (stateStage.status !== "done" && priorNativeStage) {
    const priorRecord = state.stages.find((stage) => stage.id === priorNativeStage.id);
    const continued = transitionDecision(priorNativeStage.id);
    if (priorRecord?.status === "done" && continued?.decision === "approve_continue"
      && currentRecord.status === "not_started" && currentRecord.current_version === null
      && state.cursor_epoch !== continued.capability_epoch
      && state.pause.kind !== "done"
      && state.dispatch_capability === undefined) return true;
  }
  const currentDecision = transitionDecision(currentStage.id);
  if (currentDecision?.decision === "request_changes"
    && stateStage.status === "in_progress"
    && currentRecord.status === "revision_required"
    && currentRecord.last_feedback === currentDecision.rationale
    && state.cursor_epoch !== currentDecision.capability_epoch
    && (state.dispatch_capability === undefined || state.dispatch_capability.status === "ready")) return true;
  if (currentDecision?.decision === "approve_stop"
    && stateStage.status === "done"
    && currentRecord.status === "approved"
    && state.pause.kind === "done"
    && (state.dispatch_capability === undefined
      || state.dispatch_capability.status === "complete"
      || state.dispatch_capability.status === "invalidated")) return true;
  return false;
}

function preparationRefreshAllowed(
  state: TeamState | null,
  opts: WorkflowPrepareOptions,
  classification: Classification | undefined,
  rootIdentity: PreparationRootIdentity | undefined,
  profiles: readonly Profile[],
): boolean {
  if (!state || !classification || !rootIdentity || opts.feature_id === undefined || opts.run_key === undefined) return false;
  const handoff = state.preparation_handoff;
  if (!Number.isSafeInteger(state.state_revision) || (state.state_revision as number) < 1
    || !state.classification || !state.specification
    || state.classification.workflow !== "spec-preparation"
    || state.specification.source_kind !== "native"
    || classification.workflow !== "spec-preparation"
    || preparationRefreshHasActiveWork(state)) return false;
  const workspaceRootIdentity = state.specification.project_root_identity;
  if (state.specification.feature_id !== opts.feature_id
    || state.run_key !== opts.run_key
    || state.branch !== opts.branch
    || state.task !== opts.task
    || digestOf(state.classification) !== digestOf(classification)
    || !workspaceRootIdentity
    || workspaceRootIdentity.canonical_path !== rootIdentity.canonical_path
    || workspaceRootIdentity.dev !== rootIdentity.dev
    || workspaceRootIdentity.ino !== rootIdentity.ino) return false;
  const transitioned = nativePreparationTransitionEvidence(state, profiles);
  if (!handoff) return transitioned;
  if (!Number.isSafeInteger(handoff.state_revision) || handoff.state_revision < 1
    || handoff.feature_id !== opts.feature_id
    || handoff.run_key !== opts.run_key
    || handoff.branch !== opts.branch
    || handoff.task !== state.task
    || digestOf(handoff.classification) !== digestOf(state.classification)
    || handoff.root_identity.canonical_path !== rootIdentity.canonical_path
    || handoff.root_identity.dev !== rootIdentity.dev
    || handoff.root_identity.ino !== rootIdentity.ino
    || !verifyPreparationHandoffDigest(handoff)) return false;
  if (preparationHandoffMatchesCurrentPostimage(state)) return false;
  const retiredCapability = state.dispatch_capability?.status === "complete" || state.dispatch_capability?.status === "invalidated";
  return !retiredCapability || transitioned;
}

function prepareFeatureSlug(branch: string): string | undefined {
  const slug = branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
  return slug || "default";
}

function createPreparationHandoff(
  opts: WorkflowPrepareOptions,
  input: Parameters<typeof createUnsignedPreparationHandoff>[0],
  state: TeamState,
): WorkflowPreparationHandoff {
  const ownedRoot = opts.pinnedRoot ? undefined : PinnedProjectRoot.open(opts.cwd);
  const pinnedRoot = opts.pinnedRoot ?? ownedRoot;
  if (!pinnedRoot) throw new Error("workflow preparation could not pin the project root for native handoff authentication");
  const workspace = state.specification;
  try {
    return createUnsignedPreparationHandoff({
      ...input,
      source_kind: workspace?.source_kind ?? "native",
      constitution_binding: workspace?.constitution_binding ?? null,
      constitution_gate_ref: workspace?.constitution_gate_ref ?? null,
      capacity: 1,
      authentication: {
        source_kind: workspace?.source_kind ?? "native",
        constitution_binding: workspace?.constitution_binding ?? null,
        constitution_gate_ref: workspace?.constitution_gate_ref ?? null,
        capacity: 1,
        pinned_root: pinnedRoot,
      },
    });
  } finally {
    ownedRoot?.close();
  }
}

function strictRunConstitutionGuard(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot | undefined,
  state: TeamState | null,
): void {
  const binding = state?.specification?.constitution_binding;
  if (!binding) return;
  const ownedRoot = pinnedRoot ? null : PinnedProjectRoot.open(projectRoot);
  const root = pinnedRoot ?? ownedRoot;
  if (!root) throw new Error("SPEC_CONSTITUTION_IMPACT_PENDING: project root could not be pinned for constitution freshness");
  try {
    const current = readPinnedCurrentConstitution(root.canonical_root, root, binding);
    if (!current.ok) throw new Error("SPEC_CONSTITUTION_IMPACT_PENDING: " + current.error);
    if (!root.isStable()) throw new Error("SPEC_CONSTITUTION_IMPACT_PENDING: project root changed after constitution freshness check");
  } finally {
    ownedRoot?.close();
  }
}

function preparationRootIdentity(cwd: string, pinnedRoot?: PinnedProjectRoot): PreparationRootIdentity {
  const canonicalPath = pinnedRoot?.canonical_root ?? realpathSync(cwd);
  const identity = pinnedRoot ?? statSync(canonicalPath);
  return { canonical_path: canonicalPath, dev: identity.dev, ino: identity.ino };
}

interface PreparationTransition {
  state: TeamState;
  profile: Profile;
  flags: ScopeFlags;
  classification: Classification;
}

/**
 * Persist PHASE-0 while holding the canonical feature-state transaction lock.
 * Every decision that depends on the existing envelope is made from the
 * lock-protected snapshot, never from the preflight read above it.
 */
export function prepareWorkflowState(opts: WorkflowPrepareOptions): PreparedWorkflowState {
  const config = resolveConfig(opts.cwd, {}, opts.pinnedRoot);
  const profiles = loadAllProfiles();
  const selectorProvided = opts.feature_id !== undefined || opts.run_key !== undefined;
  if (selectorProvided && (opts.feature_id === undefined || opts.run_key === undefined)) {
    throw new Error("explicit run selection requires both feature_id and run_key");
  }
  if (opts.feature_id !== undefined && !isSafeFeatureId(opts.feature_id)) {
    throw new Error(`unsafe feature_id selector ${JSON.stringify(opts.feature_id)}`);
  }
  let resolvedExisting = selectorProvided
    ? opts.pinnedRoot
      ? resolvePreparationStatePinned(opts.cwd, opts.pinnedRoot, { feature_id: opts.feature_id!, run_key: opts.run_key! })
      : resolvePreparationState(opts.cwd, opts.branch, { feature_id: opts.feature_id!, run_key: opts.run_key! })
    : opts.pinnedRoot
      ? resolveStatePinnedActive(opts.cwd, opts.pinnedRoot, opts.branch)
      : resolveState(opts.cwd, opts.branch);
  const emptyExisting: ResolvedState = { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
  let existing = opts.adaptiveQuick && !selectorProvided && !resolvedExisting.isLegacy ? emptyExisting : resolvedExisting;
  const isContinuation = Boolean(opts.continuation);
  const specificationRequest = opts.classification?.type === "SPEC"
    || opts.classification?.workflow === "spec-preparation"
    || Boolean(isContinuation && existing.state?.specification?.source_kind === "native");
  const preparationAuthorityRequired = specificationRequest && selectorProvided;
  const preparationClassification = preparationAuthorityRequired ? resolveClassification(opts) : undefined;
  const preparationToken = preparationAuthorityRequired ? newPreparationToken() : undefined;
  const preparationRoot = preparationAuthorityRequired ? preparationRootIdentity(opts.cwd, opts.pinnedRoot) : undefined;
  // Hydrate specification preparation from the canonical feature workspace
  // through the caller-owned root descriptor. The TeamState projection is
  // intentionally smaller than FeatureWorkspace, so it cannot be the source
  // of truth for the constitution binding or phase versions.
  const hydratedWorkspace = specificationRequest && selectorProvided && opts.pinnedRoot && opts.feature_id && opts.run_key
    ? (() => {
        const snapshot: WorkspaceRootSnapshot = {
          lexical_root: opts.pinnedRoot!.lexical_root,
          canonical_root: opts.pinnedRoot!.canonical_root,
          dev: opts.pinnedRoot!.dev,
          ino: opts.pinnedRoot!.ino,
          pinned_root: opts.pinnedRoot!,
        };
        const resolved = resolveFeatureWorkspace(opts.cwd, { feature_id: opts.feature_id, run_key: opts.run_key }, snapshot);
        if (!resolved.ok) throw new Error(`workflow preparation could not hydrate the canonical specification workspace: ${resolved.error}`);
        return resolved.value;
      })()
    : null;
  // Workspace migration may publish a new canonical state postimage while
  // resolving the workspace. Refresh the selected state after hydration so
  // preparation never reasons from the pre-hydration snapshot or its digest.
  if (hydratedWorkspace && selectorProvided && opts.pinnedRoot && opts.feature_id && opts.run_key) {
    const refreshed = resolvePreparationStatePinned(opts.cwd, opts.pinnedRoot, {
      feature_id: opts.feature_id,
      run_key: opts.run_key,
    });
    if (refreshed.invalid || !refreshed.state) {
      throw new Error("workflow preparation could not read the canonical specification workspace postimage");
    }
    resolvedExisting = refreshed;
    existing = opts.adaptiveQuick && !selectorProvided && !refreshed.isLegacy ? emptyExisting : refreshed;
  }
  if (existing.invalid) throw new Error("workflow state is invalid or unsafe");
  if (isContinuation && (!existing.state || resolvedExisting.isStale)) {
    throw new Error(`cannot continue workflow: no non-stale state for branch ${opts.branch}`);
  }
  const existingWorkspaceSeed = Boolean(!isContinuation && existing.state && (hydratedWorkspace || stateCarriesSpecification(existing.state)) && !existing.state.classification);
  const existingImportSeed = !isContinuation && existing.state && !existing.isStale
    ? specificationImportSeed(existing.state, profiles, existing.artifactsDir ?? undefined, {
        branch: opts.branch,
        featureId: opts.feature_id ?? existing.state.specification?.feature_id ?? "",
        runKey: opts.run_key ?? existing.state.run_key ?? "",
      }, opts.pinnedRoot ? { pinnedRoot: opts.pinnedRoot } : undefined)
    : null;
  if (existingImportSeed && !existingImportSeed.ok && existingImportSeed.candidate) throw new Error(existingImportSeed.error);
  const preparationRefreshCandidate = !isContinuation
    && preparationAuthorityRequired
    && preparationRefreshAllowed(existing.state, opts, preparationClassification, preparationRoot, profiles);
  if (!isContinuation && existing.state && !existing.isStale && !existingWorkspaceSeed && !existingImportSeed?.ok && !preparationRefreshCandidate) {
    throw new Error("workflow state already exists for this branch; use continuation mode");
  }
  if (isContinuation && existing.state) {
    const carried = stateCarriesSpecification(existing.state);
    if (carried && opts.feature_id === undefined) {
      throw new Error("explicit feature_id and run_key selectors are required to continue a specification workspace run");
    }
    if (opts.run_key !== undefined && typeof existing.state.run_key === "string" && existing.state.run_key !== opts.run_key) {
      throw new Error(`run_key '${opts.run_key}' does not match the engine-bound run '${existing.state.run_key}'`);
    }
    if (carried && opts.feature_id !== undefined && existing.state.specification && existing.state.specification.feature_id !== opts.feature_id) {
      throw new Error(`feature_id '${opts.feature_id}' does not match the engine-bound workspace '${existing.state.specification.feature_id}'`);
    }
  }

  // A selector-free stale resolution is only historical provenance: the
  // active-feature pointer may still name another branch. The transaction may
  // carry that source for CAS purposes, but state.ts retargets the commit to
  // this branch derived destination while holding the lock. Explicit feature
  // selectors remain exact and branch-neutral through their selected target.
  const quickStateDir = resolvePath(opts.cwd, ".work-state");
  const quickLegacyTarget: ResolvedState = {
    state: null,
    statePath: resolvePath(quickStateDir, "team-state.json"),
    stateDir: quickStateDir,
    artifactsDir: resolvePath(quickStateDir, "artifacts"),
    isLegacy: true,
    isStale: false,
  };
  const stateTarget = opts.adaptiveQuick && !selectorProvided
    ? { target: existing.statePath && existing.stateDir && existing.artifactsDir ? { ...existing, isStale: false } : quickLegacyTarget }
    : (selectorProvided || Boolean(existing.state)) && existing.statePath && existing.stateDir && existing.artifactsDir
      ? { target: existing }
      : { featureSlug: opts.feature_id ?? prepareFeatureSlug(opts.branch) };
  let preparationGuardState: TeamState | null = null;
  const transition = updateStateAtomically<PreparationTransition>(
    opts.cwd,
    (snapshot) => {
      const current = snapshot.state;
      preparationGuardState = current;
      if (snapshot.target.isStale && isContinuation) {
        return { op: "fail", code: "state_conflict", error: `workflow state is stale for branch ${opts.branch}` };
      }
      if (isContinuation) {
        if (!current) return { op: "fail", code: "state_missing", error: `cannot continue workflow: no state for branch ${opts.branch}` };
        if (opts.run_key !== undefined && current.run_key !== opts.run_key) {
          return { op: "fail", code: "state_conflict", error: `run_key '${opts.run_key}' does not match the engine-bound run '${current.run_key ?? ""}'` };
        }
        if (current.specification && (opts.feature_id === undefined || current.specification.feature_id !== opts.feature_id)) {
          return { op: "fail", code: "state_conflict", error: "explicit feature_id and run_key selectors do not match the engine-bound workspace" };
        }
        if (current.branch !== opts.branch) {
          return { op: "fail", code: "state_conflict", error: "branch " + opts.branch + " does not match the engine-bound branch " + current.branch };
        }
        if (preparationAuthorityRequired && opts.task !== (current.history?.[0]?.task ?? current.task)) {
          return { op: "fail", code: "state_conflict", error: "native continuation task does not match the immutable initial request" };
        }
        if (preparationAuthorityRequired && current.preparation_handoff && current.task === current.preparation_handoff.task
          && current.history?.at(-1)?.feedback !== opts.continuation?.feedback) {
          return { op: "fail", code: "state_conflict", error: "native continuation feedback does not match the prepared postimage" };
        }
        if (preparationAuthorityRequired && exactNativeContinuationReplay(current, opts.continuation!, opts.feature_id!, opts.run_key ?? current.run_key ?? "")) {
          const replayProfile = profiles.find((candidate) => candidate.name === current.classification.workflow);
          if (!replayProfile) return { op: "fail", code: "state_invalid", error: "no profile matches continuation workflow " + JSON.stringify(current.classification.workflow) };
          return {
            op: "discard",
            value: {
              state: current,
              profile: replayProfile,
              flags: current.scope ?? resolveScope([], config),
              classification: current.classification,
            },
          };
        }
        if (preparationAuthorityRequired && current.preparation_handoff) {
          return { op: "fail", code: "state_conflict", error: "native continuation handoff is stale for the current postimage" };
        }
      }
      const workspaceSeed = Boolean(!isContinuation && current && (hydratedWorkspace || stateCarriesSpecification(current)) && !current.classification);
      const importSeed = !isContinuation && current && !snapshot.target.isStale
        ? specificationImportSeed(current, profiles, snapshot.target.artifactsDir ?? undefined, {
            branch: opts.branch,
            featureId: opts.feature_id ?? current.specification?.feature_id ?? "",
            runKey: opts.run_key ?? current.run_key ?? "",
          }, opts.pinnedRoot ? { pinnedRoot: opts.pinnedRoot } : undefined)
        : null;
      if (importSeed && !importSeed.ok && importSeed.candidate) {
        return { op: "fail", code: "state_invalid", error: importSeed.error };
      }
      const refresh = !isContinuation
        && preparationAuthorityRequired
        && preparationRefreshAllowed(current, opts, preparationClassification, preparationRoot, profiles);
      if (refresh && current) {
        const profile = profiles.find((candidate) => candidate.name === current.classification.workflow);
        if (!profile) return { op: "fail", code: "state_invalid", error: "no profile matches preparation workflow " + JSON.stringify(current.classification.workflow) };
        const stateRevision = snapshot.revision + 1;
        const postimage = JSON.parse(JSON.stringify({ ...current, state_revision: stateRevision })) as TeamState;
        const authority = createPreparationHandoff(opts, {
          feature_id: opts.feature_id!,
          run_key: opts.run_key!,
          branch: opts.branch,
          task: current.task,
          classification: current.classification,
          state_revision: stateRevision,
          state_digest: preparationStateDigest(postimage, stateRevision),
          root_identity: preparationRoot!,
          token: preparationToken!,
        }, postimage);
        const prepared = { ...current, preparation_handoff: authority };
        preparationGuardState = prepared;
        return {
          op: "commit",
          state: prepared,
          value: {
            state: prepared,
            profile,
            flags: current.scope ?? resolveScope([], config),
            classification: current.classification,
          },
        };
      }
      if (!isContinuation && current && !snapshot.target.isStale && !workspaceSeed && !importSeed?.ok) {
        const requested = buildPreparationTransition(current, false, undefined, hydratedWorkspace ?? undefined);
        if (exactPreparationReplay(current, requested.state)) return { op: "discard", value: requested };
        return { op: "fail", code: "state_conflict", error: "workflow state was created concurrently with different lifecycle state" };
      }
      const requested = buildPreparationTransition(current, workspaceSeed, importSeed?.ok ? importSeed.profile : undefined, hydratedWorkspace ?? undefined);
      const authority = preparationAuthorityRequired
        ? (!isContinuation ? current?.preparation_handoff : undefined) ?? (() => {
            const stateRevision = snapshot.revision + 1;
            const postimage = JSON.parse(JSON.stringify({ ...requested.state, state_revision: stateRevision })) as TeamState;
            return createPreparationHandoff(opts, {
              feature_id: opts.feature_id!,
              run_key: opts.run_key!,
              branch: opts.branch,
              task: requested.state.task,
              classification: requested.classification,
              state_revision: stateRevision,
              state_digest: preparationStateDigest(postimage, stateRevision),
              root_identity: preparationRoot!,
              token: preparationToken!,
            }, postimage);
          })()
        : undefined;
      const prepared = authority ? { ...requested, state: { ...requested.state, preparation_handoff: authority } } : requested;
      preparationGuardState = prepared.state;
      if (importSeed?.ok && exactPreparationReplay(current!, prepared.state)) return { op: "discard", value: prepared };
      return { op: "commit", state: prepared.state, value: prepared };
    },
    "target" in stateTarget
      ? { target: stateTarget.target, branch: opts.branch, branchNeutral: selectorProvided || Boolean(opts.adaptiveQuick), ...(selectorProvided ? { selector: { feature_id: opts.feature_id!, run_key: opts.run_key! } } : {}), ...(opts.pinnedRoot ? { pinnedRoot: opts.pinnedRoot } : {}), preCommit: () => strictRunConstitutionGuard(opts.cwd, opts.pinnedRoot, preparationGuardState) }
      : { featureSlug: stateTarget.featureSlug, branch: opts.branch, branchNeutral: selectorProvided, ...(selectorProvided ? { selector: { feature_id: opts.feature_id!, run_key: opts.run_key! } } : {}), ...(opts.pinnedRoot ? { pinnedRoot: opts.pinnedRoot } : {}), preCommit: () => strictRunConstitutionGuard(opts.cwd, opts.pinnedRoot, preparationGuardState) },
  );
  if (!transition.ok) throw new Error(`${transition.code}: ${transition.error}`);
  if (!transition.state || !transition.target.statePath || !transition.value) throw new Error("workflow state preparation committed without a readable state");
  const canonicalize = (value: string | null, label: string): string | null => {
    if (value === null) return null;
    if (opts.pinnedRoot) {
      const relative = opts.pinnedRoot.relativePath(value);
      if (relative === null) throw new Error(`workflow state preparation produced an unauthorized ${label}`);
      return resolvePath(opts.pinnedRoot.canonical_root, relative);
    }
    try { return realpathSync(value); }
    catch { throw new Error(`workflow state preparation produced an unavailable ${label}`); }
  };
  const canonicalTarget: ResolvedState = {
    ...transition.target,
    statePath: canonicalize(transition.target.statePath, "state path"),
    stateDir: canonicalize(transition.target.stateDir, "state directory"),
    artifactsDir: canonicalize(transition.target.artifactsDir, "artifacts directory"),
  };
  if (!canonicalTarget.statePath || !canonicalTarget.stateDir || !canonicalTarget.artifactsDir) throw new Error("workflow state preparation committed without canonical paths");
  const { profile, flags, classification } = transition.value;
  const resolveSlots = (stage: NonNullable<Profile["stages"][number]>): DispatchSlot[] =>
    resolveStageDispatchSlots(stage, { cwd: opts.cwd, flags, resolveDevAgent: () => flags.dev_agent });
  const expectedRoster = (stage: NonNullable<Profile["stages"][number]>): Array<{ role: string; agent: string }> =>
    resolveSlots(stage).map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) }));
  const committedTarget = { target: canonicalTarget };
  return {
    config,
    profile,
    flags,
    classification,
    state: transition.state,
    statePath: canonicalTarget.statePath,
    artifactsDir: canonicalTarget.artifactsDir,
    stateTarget: committedTarget,
    expectedRoster,
    ...(transition.state.preparation_handoff ? { preparation_handoff: transition.state.preparation_handoff } : {}),
  };

  function buildPreparationTransition(current: TeamState | null, workspaceSeed: boolean, trustedImportProfile?: Profile, hydrated?: NonNullable<typeof hydratedWorkspace>): PreparationTransition {
    if (trustedImportProfile) {
      if (!current?.classification) throw new Error("trusted specification import seed is missing its classification");
      return {
        state: current,
        profile: trustedImportProfile,
        flags: current.scope ?? resolveScope([], config),
        classification: current.classification,
      };
    }
    const persistedClassification = isContinuation ? current?.classification : undefined;
    const specificationProfile = workspaceSeed ? specificationSeedProfile(profiles, current) : undefined;
    const classification = persistedClassification ?? resolveClassification(opts, specificationProfile?.name);
    const profile = persistedClassification
      ? profiles.find((candidate) => candidate.name === persistedClassification.workflow)
      : specificationProfile ?? selectProfile(profiles, classification);
    if (!profile) throw new Error(`no profile matches classification ${JSON.stringify(classification)}`);
    const flags = opts.files !== undefined
      ? resolveScope(opts.files, config)
      : isContinuation && current?.scope
        ? current.scope
        : resolveScope([], config);
    const reopened = opts.continuation
      ? reopenFromFeedback(current!, opts.continuation.feedback, opts.continuation.stageId, { preserveTask: preparationAuthorityRequired })
      : null;
    const preservedCapability = Boolean(
      reopened
      && current?.dispatch_capability?.issued_for?.stage_cursor === opts.continuation?.stageId
      && (current?.dispatch_capability?.status === "ready" || current?.dispatch_capability?.status === "dispatched"),
    );
    const state: TeamState = reopened
      ? {
          ...reopened,
          ...(preservedCapability ? {} : { dispatch_capability: undefined, cursor_epoch: undefined }),
          ...(hydrated ? { specification: hydrated } : {}),
          scope: flags,
          policy: { ...(reopened.policy ?? {}), strict_orchestrator: true },
        }
      : {
          schema: 1,
          branch: opts.branch,
          classification,
          task: opts.task,
          workflow_override: opts.classification?.workflow !== undefined,
          issue: opts.issue ?? null,
          stage_cursor: profile.stages[0]?.id ?? "",
          stages: profile.stages.map((s) => ({ id: s.id, status: "pending" as const })),
          pause: { kind: "none" as const, reason: "" },
          artifacts: {},
          scope: flags,
          policy: { strict_orchestrator: true },
          profile_hash: profileHash(profile),
          config_hash: config.config_hash,
          run_key: opts.run_key ?? opts.branch,
          updated_at: new Date().toISOString(),
          ...(workspaceSeed ? { specification: hydrated ?? current!.specification } : {}),
          // The bare adaptive envelope is the durable routing authority. Carry
          // it into the first TeamState postimage so a crash between seeding
          // and route replay cannot downgrade a nested full run to root QUICK.
          ...(workspaceSeed && current?.adaptive_preparation ? { adaptive_preparation: current.adaptive_preparation } : {}),
        } satisfies TeamState;
    return { state, profile, flags, classification };
  }
}

/** Prepare a specification workspace through a caller-owned pinned root. */
export function prepareWorkflowStatePinned(
  opts: WorkflowPrepareOptions,
  pinnedRoot: PinnedProjectRoot,
): PreparedWorkflowState {
  if (!(pinnedRoot instanceof PinnedProjectRoot) || !pinnedRoot.isStable()) {
    throw new Error("pinned project root is unavailable or changed before workflow state preparation");
  }
  return prepareWorkflowState({ ...opts, pinnedRoot });
}

type DurableStageBinding = {
  stageId: string;
  capabilityId: string;
  dispatchToken?: string;
  advanceToken?: string;
  epoch: string;
  profileHash: string;
  configHash: string;
  policyHash: string;
  persisted: boolean;
};

function stagePolicyHash(
  stage: NonNullable<Profile["stages"][number]>,
  flags: ScopeFlags,
  expectedRoster: Array<{ role: string; agent: string }>,
  state: TeamState,
): string {
  return digestOf({
    stage,
    flags,
    expected_roster: expectedRoster,
    checkpoint_policy: state.checkpoint_policy ?? null,
    completion_intent: state.completion_intent ?? null,
    policy: state.policy ?? null,
  });
}

function stageBindingPostimage(
  binding: DurableStageBinding,
  state: TeamState,
  opts: RunOptions,
): PersistedStagePostimage {
  return {
    ...(opts.feature_id !== undefined ? { feature_id: opts.feature_id } : {}),
    capability_id: binding.capabilityId,
    run_key: state.run_key ?? state.branch,
    branch: state.branch,
    workflow: state.classification.workflow,
    profile_hash: binding.profileHash,
    stage_cursor: binding.stageId,
    cursor_epoch: binding.epoch,
    config_hash: binding.configHash,
    policy_hash: binding.policyHash,
    ...(state.work_identity ? { work_identity: state.work_identity } : {}),
  };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const pinnedRoot = opts.pinnedRoot ?? PinnedProjectRoot.open(opts.cwd);
  if (!pinnedRoot) throw new Error("current project root could not be pinned for workflow run");
  try {
    return await runPinned({ ...opts, pinnedRoot }, pinnedRoot);
  } finally {
    if (opts.pinnedRoot === undefined) pinnedRoot.close();
  }
}

async function runPinned(opts: RunOptions, pinnedRoot: PinnedProjectRoot): Promise<RunResult> {
  if (!pinnedRoot.isStable()) throw new Error("pinned project root is unavailable or changed before workflow run");
  const prepared = prepareWorkflowState({ ...opts, pinnedRoot });
  const { config, profile, flags, classification, state: initialState, statePath, artifactsDir, stateTarget, expectedRoster } = prepared;
  const completed = new Set(initialState.stages.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id));
  const runnableProfile = completed.size === 0 ? profile : { ...profile, stages: profile.stages.filter((s) => !completed.has(s.id)) };
  let durableStage: DurableStageBinding | null = null;
  const explicitRun = opts.feature_id !== undefined || opts.run_key !== undefined;
  const artifactsDirRelative = pinnedRoot.relativePath(artifactsDir);
  if (artifactsDirRelative === null) throw new Error("workflow artifacts directory escapes the pinned project root");
  let stateRawHash: string | null = null;
  const stateMutationOptions = { target: stateTarget.target!, branch: opts.branch, branchNeutral: explicitRun, pinnedRoot, ...(explicitRun ? { selector: { feature_id: opts.feature_id!, run_key: opts.run_key! } } : {}) };
  let lifecycleGuardState: TeamState | null = null;
  const lifecyclePreCommit = (): void => strictRunConstitutionGuard(opts.cwd, pinnedRoot, lifecycleGuardState);
  const lifecycleMutationOptions = { ...stateMutationOptions, preCommit: lifecyclePreCommit };
  const ctx: StageContext = {
    cwd: opts.cwd,
    state: initialState,
    artifactsDir,
    pinnedRoot,
    artifactsDirRelative,
    featureId: opts.feature_id,
    flags,
    agent: (role) => resolveAgentForRole(role, config),
    task: opts.taskTool,
    orchestrate: opts.orchestrate
      ? (args) => opts.orchestrate!({ ...args, state: ctx.state })
      : undefined,
    pause: opts.pause ?? (async () => undefined),
    onStageStart: (stageId) => {
      const stage = profile.stages.find((candidate) => candidate.id === stageId);
      const outcome = updateStateAtomically<{ durableStage: DurableStageBinding | null }>(
        opts.cwd,
        (snapshot) => {
          const current = snapshot.state;
          lifecycleGuardState = current;
          if (!current) return { op: "fail", code: "state_missing", error: "workflow state is missing" };
          if (snapshot.target.isStale) return { op: "fail", code: "state_conflict", error: `workflow state is stale for branch ${opts.branch}` };
          const entry = current.stages.find((candidate) => candidate.id === stageId);
          if (!entry) return { op: "fail", code: "state_invalid", error: `workflow stage '${stageId}' is unknown` };
          if (entry.status === "done" || entry.status === "skipped" || entry.status === "failed") {
            return { op: "fail", code: "state_conflict", error: `workflow stage '${stageId}' is already ${entry.status}` };
          }
          if (!stage) return { op: "fail", code: "state_invalid", error: `workflow stage '${stageId}' is unavailable in profile` };
          const kind: "single" | "consilium" | "none" = stage.type === "single" ? "single" : stage.type === "consilium" ? "consilium" : "none";
          const expected = kind === "none" ? [] : expectedRoster(stage);
          const profileDigest = profileHash(profile);
          const policyDigest = stagePolicyHash(stage, flags, expected, current);
          const armed = current.dispatch_capability;
          const issuedFor = armed?.issued_for;
          const activeForStage = issuedFor?.stage_cursor === stageId
            && (armed?.status === "ready" || armed?.status === "dispatched");
          if (activeForStage) {
            if (!armed || !issuedFor || !armed.capability_id) {
              return { op: "fail", code: "state_invalid", error: `persisted durable stage '${stageId}' is missing or stale` };
            }
            const localBinding = durableStage?.stageId === stageId && !durableStage.persisted ? durableStage : null;
            const bindingExact = Boolean(
              current.profile_hash === profileDigest
              && current.config_hash === config.config_hash
              && issuedFor
              && issuedFor.run_key === (current.run_key ?? current.branch)
              && issuedFor.branch === current.branch
              && issuedFor.workflow === profile.name
              && issuedFor.profile_hash === profileDigest
              && issuedFor.cursor_epoch === current.cursor_epoch
              && armed?.kind === kind
              && (armed.policy_hash === policyDigest || localBinding !== null)
              && JSON.stringify(armed.expected_roster ?? []) === JSON.stringify(expected)
              && JSON.stringify(armed.expected_roles ?? []) === JSON.stringify(expected.map((entry) => entry.role))
              && armed.expected_count === expected.length
              && Array.isArray(armed.dispatches)
              && armed.dispatches.every((record) => {
                const identity = record.work_identity;
                return identity !== undefined
                  && identity.capability_id === armed.capability_id
                  && identity.capability_epoch === issuedFor.cursor_epoch
                  && identity.dispatch_id === record.id
                  && identity.slot_id === record.role;
              }),
            );
            if (!bindingExact && localBinding === null) {
              return { op: "fail", code: "state_invalid", error: `persisted durable stage '${stageId}' is missing or stale` };
            }
            const persistedBinding: DurableStageBinding = localBinding ?? {
              stageId,
              capabilityId: armed.capability_id,
              epoch: issuedFor.cursor_epoch,
              profileHash: profileDigest,
              configHash: config.config_hash,
              policyHash: policyDigest,
              persisted: true,
            };
            if (entry.status === "in_progress") return { op: "discard", value: { durableStage: persistedBinding } };
            const next = setStageStatus(current, stageId, "in_progress", opts.cwd);
            return { op: "commit", state: next, value: { durableStage: persistedBinding } };
          }
          const next = setStageStatus(current, stageId, "in_progress", opts.cwd);
          const issued = createCapability({
            run_key: next.run_key ?? next.branch,
            branch: next.branch,
            workflow: profile.name,
            profile_hash: profileDigest,
            stage_cursor: stage.id,
            kind,
            expected_roster: expected,
            policy_hash: policyDigest,
          });
          const nextState: TeamState = {
            ...next,
            run_key: next.run_key ?? next.branch,
            cursor_epoch: issued.state.issued_for!.cursor_epoch,
            profile_hash: profileDigest,
            config_hash: config.config_hash,
            dispatch_capability: issued.state,
          };
          const nextDurableStage: DurableStageBinding = {
            stageId,
            capabilityId: issued.capability_id,
            dispatchToken: issued.dispatch_token,
            advanceToken: issued.advance_token,
            epoch: issued.state.issued_for!.cursor_epoch,
            profileHash: profileDigest,
            configHash: config.config_hash,
            policyHash: policyDigest,
            persisted: false,
          };
          return { op: "commit", state: nextState, value: { durableStage: nextDurableStage } };
        },
        lifecycleMutationOptions,
      );
      if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.error}`);
      if (!outcome.state || !outcome.value) throw new Error("workflow stage start committed without a readable state");
      ctx.state = outcome.state;
      durableStage = outcome.value.durableStage;
      stateRawHash = readStatePinned(statePath, pinnedRoot).rawHash;
    },
    onStageComplete: (stageId, status) => {
      const outcome = updateStateAtomically<null>(
        opts.cwd,
        (snapshot) => {
          if (stateRawHash !== null && snapshot.raw_hash !== stateRawHash) return { op: "fail", code: "state_conflict", error: "workflow state changed during the stage lifecycle" };
          const current = snapshot.state;
          lifecycleGuardState = current;
          if (!current) return { op: "fail", code: "state_missing", error: "workflow state is missing" };
          if (snapshot.target.isStale) return { op: "fail", code: "state_conflict", error: `workflow state is stale for branch ${opts.branch}` };
          const entry = current.stages.find((candidate) => candidate.id === stageId);
          if (!entry) return { op: "fail", code: "state_invalid", error: `workflow stage '${stageId}' is unknown` };
          // A missing/invalid checkpoint is a resumable pause, not a failed
          // stage. Keep the stage pending so continuation can answer it.
          if (
            status === "failed"
            && (current.pause?.kind === "user_checkpoint" || current.pause?.kind === "needs_human" || current.pause?.kind === "background_wait")
          ) return { op: "discard", value: null };
          if ((entry.status === "done" || entry.status === "skipped" || entry.status === "failed") && entry.status !== status) {
            return { op: "fail", code: "state_conflict", error: `workflow stage '${stageId}' is already ${entry.status}` };
          }
          if (entry.status === status) return { op: "discard", value: null };
          return { op: "commit", state: setStageStatus(current, stageId, status, opts.cwd), value: null };
        },
        lifecycleMutationOptions,
      );
      if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.error}`);
      if (!outcome.state) throw new Error("workflow stage completion committed without a readable state");
      ctx.state = outcome.state;
      stateRawHash = readStatePinned(statePath, pinnedRoot).rawHash;
    },
    log: opts.log ?? (() => undefined),
    resolveDevAgent: () => flags.dev_agent,
    durable: {
      authorize: (role, agent) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const binding = durableStage;
        const currentSnapshot = readStatePinned(statePath, pinnedRoot);
        if (currentSnapshot.rawHash !== stateRawHash) return { ok: false, error: "workflow state changed during the stage lifecycle" };
        const current = currentSnapshot.state;
        const postimage = stageBindingPostimage(binding, current, opts);
        const input = {
          ...postimage,
          role,
          agent,
          task_id: dispatchTaskId(binding.capabilityId, postimage.run_key, postimage.branch, postimage.workflow, binding.stageId, role),
        };
        const durableOptions = { pinnedRoot, expectedStateRawHash: currentSnapshot.rawHash };
        const r = binding.persisted
          ? authorizeDispatchFromPersisted(opts.cwd, input, durableOptions)
          : authorizeDispatch(opts.cwd, { ...input, token: binding.dispatchToken! }, durableOptions);
        if (r.ok) {
          ctx.state = r.state;
          stateRawHash = readStatePinned(statePath, pinnedRoot).rawHash;
        }
        return r.ok && r.record ? { ok: true, dispatchId: r.record.id, state: r.state } : { ok: false, error: r.ok ? "missing dispatch record" : r.error };
      },
      complete: (dispatchId, output, outcome, artifactIds, providerId) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const binding = durableStage;
        const currentSnapshot = readStatePinned(statePath, pinnedRoot);
        const current = currentSnapshot.state;
        if (currentSnapshot.rawHash !== stateRawHash) return { ok: false, error: "workflow state changed during the stage lifecycle" };
        const postimage = stageBindingPostimage(binding, current, opts);
        const input = {
          ...postimage,
          dispatch_id: dispatchId,
          outcome,
          evidence: output || (outcome === "failed" ? "task failed" : "task completed"),
          artifact_ids: artifactIds,
          provider_id: providerId,
        };
        const durableOptions = { pinnedRoot, expectedStateRawHash: currentSnapshot.rawHash };
        const r = binding.persisted
          ? completeDispatchFromPersisted(opts.cwd, input, durableOptions)
          : completeDispatch(opts.cwd, { ...input, token: binding.dispatchToken! }, durableOptions);
        if (r.ok) {
          ctx.state = r.state;
          stateRawHash = readStatePinned(statePath, pinnedRoot).rawHash;
        }
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      advance: (evidence) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const binding = durableStage;
        const currentSnapshot = readStatePinned(statePath, pinnedRoot);
        const current = currentSnapshot.state;
        const stageDef = profile.stages.find((candidate) => candidate.id === binding.stageId);
        if (currentSnapshot.rawHash !== stateRawHash) return { ok: false, error: "workflow state changed during the stage lifecycle" };
        if (stageDef?.checkpoint) {
          const checkpointPause = updateStateAtomically<string | null>(
            opts.cwd,
            (snapshot) => {
              const checkpointState = snapshot.state;
              lifecycleGuardState = checkpointState;
              if (stateRawHash !== null && snapshot.raw_hash !== stateRawHash) return { op: "fail", code: "state_conflict", error: "workflow state changed during the stage lifecycle" };
              if (!checkpointState) return { op: "fail", code: "state_missing", error: "workflow state is missing" };
              if (snapshot.target.isStale) return { op: "fail", code: "state_conflict", error: `workflow state is stale for branch ${opts.branch}` };
              const checkpoint = validateCheckpointForAdvance(stageDef, checkpointState);
              if (checkpoint.ok) return { op: "discard", value: null };
              const pauseKind = checkpoint.pauseKind ?? (checkpoint.code === "checkpoint_unresolved" ? "user_checkpoint" : "needs_human");
              const error = `${checkpoint.code}: ${checkpoint.error}`;
              if (checkpointState.pause?.kind === pauseKind && checkpointState.pause.reason === checkpoint.error) {
                return { op: "discard", value: error };
              }
              if (checkpointState.pause?.kind && checkpointState.pause.kind !== "none") {
                return { op: "fail", code: "state_conflict", error: `workflow pause state changed to '${checkpointState.pause.kind}'` };
              }
              return { op: "commit", state: setPause(checkpointState, pauseKind, checkpoint.error), value: error };
            },
            lifecycleMutationOptions,
          );
          if (!checkpointPause.ok) return { ok: false, error: `${checkpointPause.code}: ${checkpointPause.error}` };
          if (checkpointPause.state) {
            ctx.state = checkpointPause.state;
            // The checkpoint pause is itself a committed durable transition.
            // Refresh the lifecycle hash before returning the resumable error,
            // otherwise onStageComplete mistakes our own pause write for an
            // external state race and throws state_conflict.
            stateRawHash = readStatePinned(statePath, pinnedRoot).rawHash;
          }
          if (checkpointPause.value) return { ok: false, error: checkpointPause.value };
        }
        const postimage = stageBindingPostimage(binding, current, opts);
        const durableOptions = { pinnedRoot, expectedStateRawHash: currentSnapshot.rawHash };
        const r = binding.persisted
          ? advanceCursorFromPersisted(opts.cwd, { ...postimage, evidence }, durableOptions)
          : advanceCursor(opts.cwd, { ...postimage, token: binding.advanceToken!, evidence }, durableOptions);
        if (!r.ok) return { ok: false, error: `${r.error}: ${evidence}` };
        ctx.state = r.state;
        stateRawHash = readStatePinned(statePath, pinnedRoot).rawHash;
        if (r.handoff) {
          const nextStage = profile.stages.find((candidate) => candidate.id === r.state.stage_cursor);
          const nextExpected = nextStage && nextStage.type !== "none" ? expectedRoster(nextStage) : [];
          durableStage = {
            stageId: r.state.stage_cursor,
            capabilityId: r.handoff.capability_id,
            dispatchToken: r.handoff.dispatch_token,
            advanceToken: r.handoff.advance_token,
            epoch: r.handoff.cursor_epoch,
            profileHash: profileHash(profile),
            configHash: r.state.config_hash ?? config.config_hash,
            policyHash: nextStage ? stagePolicyHash(nextStage, flags, nextExpected, r.state) : binding.policyHash,
            persisted: false,
          };
        }
        return { ok: true, handoff: r.handoff };
      },
    },
  };
  opts.log?.(`walking profile: ${profile.name} (${runnableProfile.stages.length} stages)`);
  const outcomes = await walkProfile(profile, ctx);
  const terminalResult = updateStateAtomically<{ done: boolean }>(
    opts.cwd,
    (snapshot) => {
      const current = snapshot.state;
      lifecycleGuardState = current;
      if (!current) return { op: "fail", code: "state_missing", error: "workflow state is missing" };
      if (snapshot.target.isStale) return { op: "fail", code: "state_conflict", error: `workflow state is stale for branch ${opts.branch}` };
      const done = current.stages.every((s) => s.status === "done" || s.status === "skipped");
      if (stateRawHash !== null && snapshot.raw_hash !== stateRawHash) return { op: "fail", code: "state_conflict", error: "workflow state changed during the stage lifecycle" };
      // A loop-exhaustion or checkpoint pause is the durable outcome of the
      // run; do not overwrite it with a generic status.
      const resumablePause = current.pause.kind === "user_checkpoint"
        || current.pause.kind === "needs_human"
        || current.pause.kind === "background_wait"
        || current.pause.kind === "failed";
      if (resumablePause) return { op: "discard", value: { done } };
      const terminalKind = done ? "done" : "failed";
      if (current.pause.kind === terminalKind) return { op: "discard", value: { done } };
      if (current.pause.kind !== "none") {
        return { op: "fail", code: "state_conflict", error: `workflow pause state changed to '${current.pause.kind}'` };
      }
      return { op: "commit", state: setPause(current, terminalKind, done ? "" : "one or more stages failed"), value: { done } };
    },
    lifecycleMutationOptions,
  );
  if (!terminalResult.ok) throw new Error(`${terminalResult.code}: ${terminalResult.error}`);
  if (!terminalResult.state) throw new Error("workflow finalization completed without a readable state");
  return { classification, profile, outcomes: outcomes.map((o) => ({ stageId: o.stageId, status: o.status, note: o.note })), statePath };
}


function readStatePinned(path: string, pinnedRoot: PinnedProjectRoot): { state: TeamState; rawHash: string } {
  if (!path) throw new Error("state path missing");
  if (!pinnedRoot.isStable()) throw new Error("pinned project root changed before durable state read");
  const relativePath = pinnedRoot.relativePath(path);
  if (!relativePath) throw new Error("workflow state path escapes the pinned project root");
  try {
    const bytes = pinnedRoot.readFile(relativePath, { maxBytes: MAX_PERSISTED_STATE_BYTES }).bytes;
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const bounded = parseBoundedPersistedState(parsed);
    if (!bounded) throw new Error("workflow state exceeds bounded structural limits or has an unsafe object shape");
    const issues: string[] = [];
    const state = normalizePersistedState(bounded, issues, {
      canonical_path: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
    });
    if (!state) throw new Error(`workflow state is malformed${issues.length ? `: ${issues.join("; ")}` : ""}`);
    if (!pinnedRoot.isStable()) throw new Error("pinned project root changed after durable state read");
    return { state, rawHash: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    throw new Error(`workflow state is unreadable through the pinned root: ${error instanceof Error ? error.message : String(error)}`);
  }
}
