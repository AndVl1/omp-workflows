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

import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFileSync } from "node:fs";
import { loadAllProfiles, profileHash, resolveWorkflow, selectProfile } from "./profile.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveScope, type ScopeFlags } from "./scope.js";
import {
  DETACHED_BRANCH,
  NO_GIT_BRANCH,
  resolveActiveBranch,
  resolveCanonicalRun,
  reopenFromFeedback,
  setStageStatus,
  updateStateAtomically,
  withWorkspaceTransaction,
} from "./state.js";
import { readRequiredStageInputs, resolveStageDispatchSlots, walkProfile, type StageContext, type TaskCaller } from "./stage.js";
import { authorizeDispatch, completeDispatch, advanceCursor, createCapability, materializeMigratedDispatches, type IssuedCapability } from "./durable.js";
import { resolveCheckpointDeclaration } from "./checkpoints.js";
import { loopIterationForStage } from "./loops.js";
import { keywordClassify } from "./classify.js";
import { assertTrustedExecutionContext, LifecycleError, lifecyclePayloadHash } from "./run-lifecycle.js";
import { discoverLegacySources, migrateLegacySource, recoverLegacyMigrations } from "./run-migration.js";
import {
  finalizeCanonicalRun,
  persistCanonicalRun,
  previousReceipt,
  readRunControl,
  readRunState,
  recordPrepareReceipt,
  reworkCanonicalRunAtomically,
  resumeCanonicalRun,
  runTarget,
  runStatePath,
  selectSession,
} from "./run-store.js";
import type {
  CapturedDispatchContext,
  Classification,
  Complexity,
  Confidence,
  LifecycleMode,
  LifecycleRequest,
  Profile,
  PrepareRequestReceipt,
  RoleConfig,
  TaskType,
  TeamState,
  TrustedExecutionContext,
  WorkflowName,
} from "./types.js";
import type { DispatchSlot } from "./types.js";

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
  /** Explicit lifecycle mode; state existence never changes this value. */
  mode?: LifecycleMode;
  run_id?: string;
  request_id?: string;
  execution: TrustedExecutionContext;
  feedback?: string;
  affected_stage?: string;
}

export interface RunResult {
  classification: Classification;
  profile: Profile;
  outcomes: Array<{ stageId: string; status: "done" | "skipped" | "failed"; note: string }>;
  statePath: string | null;
}

/**
 * Resolve the authoritative classification: model first (fail closed on
 * incomplete output), keyword guess only for legacy callers.
 */
export function resolveClassification(opts: Pick<RunOptions, "task" | "autonomous" | "classification">): Classification {
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
    if (model.workflow !== undefined && model.workflow !== expected && (model.type === "SPEC" || model.type === "REGRESS" || model.type === "LECTURE_RESEARCH" || model.type === "PRODUCT_DISCOVERY")) {
      throw new Error(`classification gate: ${model.type} must resolve to '${expected}', got '${model.workflow}'`);
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

export type WorkflowPrepareOptions = Pick<RunOptions, "task" | "cwd" | "branch" | "autonomous" | "classification" | "files" | "issue" | "mode" | "run_id" | "request_id" | "execution" | "feedback" | "affected_stage">;

export interface PreparedWorkflowState {
  config: RoleConfig;
  profile: Profile;
  flags: ScopeFlags;
  classification: Classification;
  state: TeamState;
  statePath: string;
  artifactsDir: string;
  expectedRoster: (stage: NonNullable<Profile["stages"][number]>) => Array<{ role: string; agent: string }>;
  operation?: LifecycleMode;
  transition?: PrepareRequestReceipt;
}

/**
 * Persist a new PHASE-0 classification through the engine-owned state writer.
 * The interactive orchestrator must call this helper through `workflow_prepare`
 * instead of editing canonical `.work-state` files directly.
 */
type ReworkArtifactBindings = { artifactIds: Set<string>; ownedFiles: Set<string> };

function stageProducedIds(stage: Profile["stages"][number]): string[] {
  return Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
}

function collectReworkArtifactBindings(cwd: string, runId: string, current: TeamState, profile: Profile, stageId: string): ReworkArtifactBindings {
  const target = runTarget(cwd, runId);
  const runRoot = resolve(target.stateDir ?? cwd);
  const artifactRoot = resolve(target.artifactsDir ?? join(runRoot, "artifacts"));
  const artifactIds = new Set<string>();
  const ownedFiles = new Set<string>();
  const normalizeOwnedPath = (candidate: unknown): string | null => {
    if (typeof candidate !== "string" || !candidate.trim()) return null;
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(runRoot, candidate);
    const rel = relative(artifactRoot, absolute);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
    return absolute;
  };
  const addOwnedPath = (candidate: unknown): string | null => {
    const absolute = normalizeOwnedPath(candidate);
    if (!absolute) return null;
    ownedFiles.add(absolute);
    return absolute;
  };
  const index = current.stages.findIndex((entry) => entry.id === stageId);
  const profileIndex = profile.stages.findIndex((entry) => entry.id === stageId);
  const clearedStageIds = new Set(index < 0 ? [] : current.stages.slice(index).map((entry) => entry.id));
  if (profileIndex >= 0) for (const stage of profile.stages.slice(profileIndex)) {
    clearedStageIds.add(stage.id);
    for (const id of stageProducedIds(stage)) {
      artifactIds.add(id);
      addOwnedPath(join(artifactRoot, id + ".json"));
    }
  }
  for (const clearedStageId of clearedStageIds) {
    const records = current.slot_artifacts?.[clearedStageId];
    for (const slotRecords of Object.values(records?.slots ?? {})) {
      for (const [artifactId, record] of Object.entries(slotRecords ?? {})) {
        artifactIds.add(artifactId);
        addOwnedPath(record?.path);
      }
    }
  }
  const capability = current.dispatch_capability;
  const capabilityStage = capability?.issued_for?.stage_cursor;
  if (capability && capabilityStage && clearedStageIds.has(capabilityStage)) {
    for (const record of capability.dispatches ?? []) {
      for (const id of record.completion?.artifact_ids ?? []) {
        artifactIds.add(id);
        addOwnedPath(join(artifactRoot, id + ".json"));
      }
    }
  }
  for (const [artifactId, path] of Object.entries(current.artifacts ?? {})) {
    const normalized = normalizeOwnedPath(path);
    if (artifactIds.has(artifactId)) {
      addOwnedPath(path);
      continue;
    }
    if (normalized && ownedFiles.has(normalized)) artifactIds.add(artifactId);
  }
  return { artifactIds, ownedFiles };
}

export function prepareWorkflowState(opts: WorkflowPrepareOptions): PreparedWorkflowState {
  if (!opts.execution) throw new LifecycleError("lifecycle_request_conflict", "trusted execution context is required for workflow lifecycle mutation");
  assertTrustedExecutionContext(opts.execution);
  const activeBranch = resolveActiveBranch(opts.cwd);
  if (activeBranch === DETACHED_BRANCH) throw new LifecycleError("run_context_mismatch", "cannot prepare workflow state from detached HEAD", { branch: activeBranch });
  if (activeBranch === NO_GIT_BRANCH) throw new LifecycleError("run_context_mismatch", "cannot prepare workflow state outside a git worktree");
  if (opts.branch !== activeBranch) throw new LifecycleError("run_context_mismatch", `workflow branch mismatch: host is '${activeBranch}', request supplied '${opts.branch}'`, { branch: activeBranch });

  const config = resolveConfig(opts.cwd);
  const profiles = loadAllProfiles();
  const operation: LifecycleMode = opts.mode ?? "new";
  if ("continuation" in opts) {
    throw new LifecycleError("migration_required", "legacy continuation requests are unsupported; use explicit mode=resume or mode=rework with run_id, feedback, and affected_stage", { next_action: "replace continuation with an explicit lifecycle request" });
  }
  const execution = opts.execution;
  if (execution.branch !== activeBranch || execution.worktree !== opts.cwd) {
    throw new LifecycleError("run_context_mismatch", "trusted execution context does not match the host worktree", { branch: activeBranch });
  }
  const recovered = recoverLegacyMigrations(opts.cwd);
  if (recovered.pending.length > 0) throw new LifecycleError("recovery_required", `legacy migration recovery is pending for ${recovered.pending.join(", ")}`, { next_action: "retry migration recovery before preparing a workflow" });
  const legacyDiscovery = discoverLegacySources(opts.cwd);
  if (legacyDiscovery.issues.length > 0) throw new LifecycleError("migration_required", `legacy source discovery failed: ${legacyDiscovery.issues.map((issue) => issue.error).join("; ")}`, { next_action: "repair the legacy source or run explicit migration" });
  for (const source of legacyDiscovery.sources) {
    const migration = migrateLegacySource(opts.cwd, source, execution);
    if (!migration.ok) throw new LifecycleError(migration.code === "run_busy" ? "run_busy" : migration.code === "recovery_required" ? "recovery_required" : "migration_required", migration.error, { next_action: "resolve the migration result before continuing" });
  }
  const requestId = opts.request_id ?? randomUUID();
  const previousRunId = operation === "new" ? null : opts.run_id ?? null;
  if (operation !== "new" && !previousRunId) throw new LifecycleError("run_selection_required", `${operation} requires an explicit run_id before mutation`, { next_action: "resolve a run selector before calling workflow_prepare" });
  const replayReceipt = readRunControl(opts.cwd).prepare_receipts[requestId];
  if (replayReceipt) {
    const replayClassification = operation === "new" ? resolveClassification(opts) : undefined;
    const replayAffectedStage = opts.affected_stage;
    const replayRequest = {
      mode: operation,
      request_id: requestId,
      execution,
      ...(operation === "new"
        ? { task: opts.task, branch: activeBranch, classification: replayClassification, files: opts.files, issue: opts.issue ?? null }
        : operation === "resume"
          ? { run_id: previousRunId!, branch: activeBranch }
          : { run_id: previousRunId!, branch: activeBranch, feedback: opts.feedback ?? "", ...(replayAffectedStage ? { affected_stage: replayAffectedStage } : {}) }),
    } as LifecycleRequest;
    if (lifecyclePayloadHash(replayRequest) !== replayReceipt.payload_hash) {
      throw new LifecycleError("lifecycle_request_conflict", "request_id replayed with a different payload", { run_id: replayReceipt.selected_run_id });
    }
    const replayState = readRunState(opts.cwd, replayReceipt.selected_run_id);
    if (!replayState) throw new LifecycleError("recovery_required", "exact replay receipt points to a missing canonical run", { run_id: replayReceipt.selected_run_id });
    const replayProfile = profiles.find((candidate) => candidate.name === replayState.classification.workflow);
    if (!replayProfile) throw new LifecycleError("run_state_invalid", `profile '${replayState.classification.workflow}' for replayed run is unavailable`, { run_id: replayState.run_id });
    const replayFlags = replayState.scope ?? resolveScope([], config);
    const replaySlots = (stage: NonNullable<Profile["stages"][number]>): DispatchSlot[] => resolveStageDispatchSlots(stage, { cwd: opts.cwd, flags: replayFlags, resolveDevAgent: () => replayFlags.dev_agent });
    const replayRoster = (stage: NonNullable<Profile["stages"][number]>): Array<{ role: string; agent: string }> => replaySlots(stage).map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) }));
    return {
      config,
      profile: replayProfile,
      flags: replayFlags,
      classification: replayState.classification,
      state: replayState,
      statePath: runStatePath(opts.cwd, replayState.run_id!),
      artifactsDir: runTarget(opts.cwd, replayState.run_id!).artifactsDir ?? "",
      expectedRoster: replayRoster,
      operation,
      transition: replayReceipt,
    };
  }

  let state: TeamState;
  let classification: Classification;
  let profile: Profile;
  let flags: ScopeFlags;
  let transition: PrepareRequestReceipt;
  const requestedAffectedStage = opts.affected_stage;
  if (operation === "new") {
    classification = resolveClassification(opts);
    const selectedProfile = selectProfile(profiles, classification);
    if (!selectedProfile) throw new LifecycleError("run_state_invalid", `no profile matches classification ${JSON.stringify(classification)}`);
    profile = selectedProfile;
    flags = opts.files !== undefined ? resolveScope(opts.files, config) : resolveScope([], config);
    const runId = randomUUID();
    state = {
      schema: 2,
      run_id: runId,
      run_key: runId,
      lifecycle_status: "active",
      rework_generation: 0,
      branch: activeBranch,
      classification,
      title: opts.task,
      task: opts.task,
      required_inputs: Object.fromEntries(profile.stages.map((stage) => [stage.id, []])),
      decisions: [],
      required_input_receipts: {},
      workflow_override: opts.classification?.workflow !== undefined,
      issue: opts.issue ?? null,
      stage_cursor: profile.stages[0]?.id ?? "",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: "pending" as const })),
      pause: { kind: "none" as const, reason: "" },
      artifacts: {},
      scope: flags,
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      updated_at: new Date().toISOString(),
    };
    const request: LifecycleRequest = {
      mode: "new",
      request_id: requestId,
      execution,
      task: opts.task,
      branch: activeBranch,
      classification,
      files: opts.files,
      issue: opts.issue ?? null,
    };
    transition = {
      request_id: requestId,
      payload_hash: lifecyclePayloadHash(request),
      operation,
      previous_run_id: null,
      selected_run_id: runId,
      committed_at: new Date().toISOString(),
      continuation: { stage: state.stage_cursor, status: "active" },
    };
    const committed = persistCanonicalRun(opts.cwd, state, { context: execution, request, receipt: transition });
    state = committed.state;
  } else {
    const runId = previousRunId!;
    const existing = withWorkspaceTransaction(opts.cwd, () => resolveCanonicalRun(opts.cwd, { kind: "team", runId }));
    if (!existing?.state || existing.state.schema !== 2) throw new LifecycleError("run_not_found", `run '${runId}' is missing or invalid`, { run_id: runId });
    if (existing.state.branch !== activeBranch) throw new LifecycleError("run_context_mismatch", `run '${runId}' belongs to branch '${existing.state.branch}', current branch is '${activeBranch}'`, { run_id: runId, branch: existing.state.branch, next_action: `checkout '${existing.state.branch}' before resume/rework` });
    state = existing.state;
    classification = state.classification;
    profile = profiles.find((candidate) => candidate.name === classification.workflow)!;
    if (!profile) throw new LifecycleError("run_state_invalid", `profile '${classification.workflow}' for run '${runId}' is unavailable`, { run_id: runId });
    flags = state.scope ?? resolveScope([], config);
    if (operation === "resume") {
      if (state.lifecycle_status === "complete" || state.pause.kind === "done") throw new LifecycleError("run_terminal", `run '${runId}' is complete; use rework or new`, { run_id: runId });
      state = resumeCanonicalRun(opts.cwd, runId, execution);
    } else {
      const affectedStage = opts.affected_stage ?? state.stage_cursor;
      if (!profile.stages.some((candidate) => candidate.id === affectedStage)) throw new LifecycleError("run_state_invalid", "rework stage '" + affectedStage + "' is not declared by workflow '" + profile.name + "'", { run_id: runId });
      if (!opts.feedback) throw new LifecycleError("lifecycle_request_conflict", "rework requires feedback", { run_id: runId });
      const activeDispatch = state.dispatch_capability?.dispatches?.find((dispatch) => ["authorized", "running", "pending"].includes(dispatch.status) && !dispatch.completion);
      if (activeDispatch) throw new LifecycleError("run_busy", `run '${runId}' has unfinished dispatch '${activeDispatch.id}'; reconcile it before rework`, { run_id: runId, next_action: "reconcile the pending worker result before rework" });
      const feedback = opts.feedback;
      const reworkRequest = { mode: operation, request_id: requestId, execution, run_id: runId, branch: activeBranch, feedback, ...(requestedAffectedStage ? { affected_stage: requestedAffectedStage } : {}) } as LifecycleRequest;
      const reworkReceipt: PrepareRequestReceipt = {
        request_id: requestId,
        payload_hash: lifecyclePayloadHash(reworkRequest),
        operation: "rework",
        previous_run_id: runId,
        selected_run_id: runId,
        committed_at: new Date().toISOString(),
        continuation: { stage: affectedStage, status: "active" },
      };
      let reworkBindings: ReworkArtifactBindings | null = null;
      state = reworkCanonicalRunAtomically(opts.cwd, runId, (current) => {
        reworkBindings = collectReworkArtifactBindings(opts.cwd, runId, current, profile, affectedStage);
        const reopened = reopenFromFeedback(current, feedback, affectedStage);
        const retainedArtifacts = Object.fromEntries(Object.entries(reopened.artifacts ?? {}).filter(([artifactId]) => !reworkBindings!.artifactIds.has(artifactId)));
        return { ...reopened, artifacts: retainedArtifacts, schema: 2, run_id: runId, run_key: runId, lifecycle_status: "active", rework_generation: (current.rework_generation ?? 0) + 1, rework_feedback: [...(current.rework_feedback ?? []), { feedback, affected_stage: affectedStage, at: new Date().toISOString() }] };
      }, reworkRequest, reworkReceipt, {
        context: execution,
        invalidateOwnedFiles: () => reworkBindings ? Array.from(reworkBindings.ownedFiles) : [],
      });
      transition = reworkReceipt;
    }
    if (operation !== "rework") selectSession(opts.cwd, execution, runId, activeBranch);
    transition = {
      request_id: requestId,
      payload_hash: lifecyclePayloadHash({ mode: operation, request_id: requestId, execution, run_id: runId, branch: activeBranch, feedback: opts.feedback ?? "", ...(requestedAffectedStage ? { affected_stage: requestedAffectedStage } : {}) }),
      operation,
      previous_run_id: runId,
      selected_run_id: runId,
      committed_at: new Date().toISOString(),
      continuation: { stage: state.stage_cursor, status: state.lifecycle_status ?? "active" },
    };
  }
  const request = {
    mode: operation,
    request_id: requestId,
    execution,
    ...(operation === "new"
      ? { task: opts.task, branch: activeBranch, classification, files: opts.files, issue: opts.issue ?? null }
      : operation === "resume"
        ? { run_id: state.run_id!, branch: activeBranch }
        : { run_id: state.run_id!, branch: activeBranch, feedback: opts.feedback ?? "", ...(requestedAffectedStage ? { affected_stage: requestedAffectedStage } : {}) }),
  } as LifecycleRequest;
  const recorded = operation === "rework" ? transition : recordPrepareReceipt(opts.cwd, request, transition);
  const resolveSlots = (stage: NonNullable<Profile["stages"][number]>): DispatchSlot[] =>
    resolveStageDispatchSlots(stage, { cwd: opts.cwd, flags, resolveDevAgent: () => flags.dev_agent });
  const expectedRoster = (stage: NonNullable<Profile["stages"][number]>): Array<{ role: string; agent: string }> =>
    resolveSlots(stage).map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) }));
  return {
    config, profile, flags, classification, state,
    statePath: runStatePath(opts.cwd, state.run_id!),
    artifactsDir: runTarget(opts.cwd, state.run_id!).artifactsDir ?? "",
    expectedRoster,
    operation,
    transition: recorded,
  };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const prepared = prepareWorkflowState(opts);
  const { config, profile, flags, classification, state: initialState, statePath, artifactsDir, expectedRoster } = prepared;
  const completed = new Set(initialState.stages.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id));
  const capabilityPending = initialState.dispatch_capability?.pending?.some((entry) =>
    entry.status === "authorized" || entry.status === "running" || entry.status === "pending",
  ) ?? false;
  if (initialState.pending || capabilityPending) {
    return { classification, profile, outcomes: [], statePath };
  }
  const runnableProfile = completed.size === 0 ? profile : { ...profile, stages: profile.stages.filter((stage) => !completed.has(stage.id)) };
  let durableStage: { stageId: string; dispatchToken: string; advanceToken: string; epoch: string; loopIteration?: number } | null = null;
  const ctx: StageContext = {
    cwd: opts.cwd,
    state: initialState,
    artifactsDir,
    flags,
    agent: (role) => resolveAgentForRole(role, config),
    task: opts.taskTool,
    orchestrate: opts.orchestrate
      ? (args) => opts.orchestrate!({ ...args, state: ctx.state })
      : undefined,
    pause: opts.pause ?? (async () => undefined),
    onStageStart: (stageId) => {
      // One cross-process transaction: the stage flips to in_progress and
      // its capability is armed against the freshly persisted state under
      // the workspace lock — never a pre-lock snapshot.
      const outcome = updateStateAtomically<{ issued: IssuedCapability | null; reuse: boolean }>(opts.cwd, (snapshot) => {
        if (!snapshot.state) return { op: "fail", code: "state_missing", error: "workflow state missing" };
        const current = snapshot.state;
        // A durable advance (normal or loop re-entry) already armed this stage
        // with a ready capability and the handoff secrets live in durableStage.
        // Reuse it so loop re-entry keeps the fresh epoch issued by
        // advanceCursor; do not re-mint a second capability for the same stage.
        const armed = current.dispatch_capability;
        if (
          durableStage &&
          durableStage.stageId === stageId &&
          armed?.issued_for?.stage_cursor === stageId &&
          (armed?.status === "ready" || armed?.status === "dispatched")
        ) {
          return { op: "commit", state: setStageStatus(current, stageId, "in_progress", opts.cwd), value: { issued: null, reuse: true } };
        }
        const stage = profile.stages.find((candidate) => candidate.id === stageId);
        // Checkpoint scope and loop iteration are part of the capability
        // binding even in interpreter mode. Issue the same fully scoped
        // capability that workflow_begin would issue; otherwise the
        // interpreter either bypasses the declared checkpoint projection or
        // fails later with an unrelated capability-drift error.
        const kind: "single" | "consilium" | "none" = stage?.type === "single" ? "single" : stage?.type === "consilium" ? "consilium" : "none";
        const next = setStageStatus(current, stageId, "in_progress", opts.cwd);
        if (!stage) {
          const nextState: TeamState = { ...next, run_key: next.run_key ?? next.branch, profile_hash: profileHash(profile) };
          delete nextState.cursor_epoch;
          delete nextState.dispatch_capability;
          delete nextState.checkpoint_policy;
          delete nextState.checkpoint_policy_binding;
          return { op: "commit", state: nextState, value: { issued: null, reuse: false } };
        }
        const iteration = loopIterationForStage(next, profile, stage.id);
        if (!iteration.ok) return { op: "fail", code: "loop_scope_invalid", error: iteration.error };
        const declaration = resolveCheckpointDeclaration(stage, profile.checkpoint_policy, next, "rebind");
        if (!declaration.ok) return { op: "fail", code: declaration.code, error: declaration.error };
        const persistedProfileHash = profileHash(profile);
        const issued = createCapability({
          run_key: next.run_key ?? next.branch,
          branch: next.branch,
          workflow: profile.name,
          profile_hash: persistedProfileHash,
          stage_cursor: stage.id,
          rework_generation: next.rework_generation ?? 0,
          kind,
          expected_roster: kind === "none" ? [] : expectedRoster(stage),
          loop_iteration: iteration.iteration,
          checkpoint_policy_hash: declaration.declaration?.policy_hash ?? null,
        });
        const materialized = materializeMigratedDispatches(next, issued.state, profile.name, stage.id, runTarget(opts.cwd, next.run_id ?? ""));
        if (!materialized.ok) return { op: "fail", code: "recovery_required", error: materialized.error };
        const migratedDispatches = materialized.records;
        const nextState: TeamState = {
          ...next,
          run_key: next.run_key ?? next.branch,
          cursor_epoch: issued.state.issued_for!.cursor_epoch,
          profile_hash: persistedProfileHash,
          dispatch_capability: migratedDispatches.length > 0
            ? { ...issued.state, status: "dispatched", dispatches: migratedDispatches }
            : issued.state,
        };
        if (nextState.migration_succeeded_slots) {
          const remainingMigrated = { ...nextState.migration_succeeded_slots };
          delete remainingMigrated[stage.id];
          if (Object.keys(remainingMigrated).length > 0) nextState.migration_succeeded_slots = remainingMigrated;
          else delete nextState.migration_succeeded_slots;
        }
        if (declaration.declaration) {
          nextState.checkpoint_policy = declaration.declaration.policy;
          nextState.checkpoint_policy_binding = {
            stage_id: stage.id,
            profile_hash: persistedProfileHash,
            policy_hash: declaration.declaration.policy_hash,
          };
        } else {
          delete nextState.checkpoint_policy;
          delete nextState.checkpoint_policy_binding;
        }
        if (
          nextState.work_identity
          && (
            nextState.work_identity.capability_id !== issued.capability_id
            || nextState.work_identity.capability_epoch !== issued.state.issued_for!.cursor_epoch
            || nextState.work_identity.stage_id !== stage.id
            || nextState.work_identity.loop_iteration !== issued.state.issued_for!.loop_iteration
          )
        ) {
          delete nextState.work_identity;
        }
        return { op: "commit", state: nextState, value: { issued, reuse: false } };
      }, { target: runTarget(opts.cwd, initialState.run_id ?? ""), branch: initialState.branch });
      if (!outcome.ok || !outcome.committed) throw new Error(outcome.ok ? "workflow stage start did not commit" : outcome.error);
      const issued = outcome.value?.issued ?? null;
      if (issued) {
        durableStage = { stageId, dispatchToken: issued.dispatch_token, advanceToken: issued.advance_token, epoch: issued.state.issued_for!.cursor_epoch, loopIteration: issued.state.issued_for!.loop_iteration };
      } else if (!outcome.value?.reuse) {
        durableStage = null;
      }
      ctx.state = outcome.state!;
    },
    onStageComplete: (stageId, status) => {
      const outcome = updateStateAtomically(opts.cwd, (snapshot) => {
        if (!snapshot.state) return { op: "fail", code: "state_missing", error: "workflow state missing" };
        const current = snapshot.state;
        // A missing/invalid checkpoint is a resumable pause, not a failed stage.
        // Keep the stage pending so continuation can answer the same checkpoint.
        if (
          status === "failed"
          && (current.pause?.kind === "user_checkpoint" || current.pause?.kind === "needs_human" || current.pause?.kind === "background_wait")
        ) {
          return { op: "discard" };
        }
        return { op: "commit", state: setStageStatus(current, stageId, status, opts.cwd) };
      }, { target: runTarget(opts.cwd, initialState.run_id ?? ""), branch: initialState.branch });
      if (!outcome.ok) throw new Error(outcome.error);
      ctx.state = outcome.state ?? ctx.state;
    },
    log: opts.log ?? (() => undefined),
    resolveDevAgent: () => flags.dev_agent,
    durable: {
      readInputs: (stageId) => {
        const stage = profile.stages.find((candidate) => candidate.id === stageId);
        if (!stage) return { ok: false, error: `recovery_required: stage ${stageId} is unavailable` };
        const current = readState(statePath);
        const read = readRequiredStageInputs(stage, current, artifactsDir);
        if (!read.ok) return read;
        if (!durableStage || current.stage_cursor !== stageId || !current.dispatch_capability?.capability_id) {
          return { ok: false, error: `recovery_required: stage ${stageId} has no persisted capability binding` };
        }
        const receipt = {
          stage_id: stageId,
          capability_id: current.dispatch_capability.capability_id,
          cursor_epoch: current.cursor_epoch ?? durableStage.epoch,
          rework_generation: current.rework_generation ?? 0,
          read_at: new Date().toISOString(),
          inputs: read.inputs.map((input) => ({ artifact_id: input.artifact_id, path: input.path, sha256: input.sha256 })),
        };
        const updated = updateStateAtomically(opts.cwd, (snapshot) => {
          if (!snapshot.state) return { op: "fail", code: "state_missing", error: "workflow state missing" };
          const state = snapshot.state;
          if (state.run_id !== current.run_id || state.stage_cursor !== stageId || state.cursor_epoch !== current.cursor_epoch) {
            return { op: "fail", code: "state_conflict", error: "required input read raced with a cursor change" };
          }
          return {
            op: "commit",
            state: {
              ...state,
              required_inputs: { ...(state.required_inputs ?? {}), [stageId]: receipt.inputs },
              required_input_receipts: { ...(state.required_input_receipts ?? {}), [stageId]: receipt },
              updated_at: new Date().toISOString(),
            },
          };
        }, { target: runTarget(opts.cwd, current.run_id ?? ""), branch: current.branch });
        if (!updated.ok || !updated.state) return { ok: false, error: updated.ok ? "recovery_required: input read receipt was not committed" : updated.error };
        ctx.state = updated.state;
        return read;
      },
      authorize: (role, agent) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath);
        const runId = current.run_id;
        if (!runId) return { ok: false, error: "canonical run identity unavailable" };
        const capabilityId = current.dispatch_capability?.capability_id;
        if (!capabilityId) return { ok: false, error: "dispatch capability unavailable" };
        const result = authorizeDispatch(opts.cwd, {
          run_id: runId,
          token: durableStage.dispatchToken,
          capability_id: capabilityId,
          run_key: current.run_key ?? current.branch,
          branch: current.branch,
          workflow: profile.name,
          profile_hash: current.profile_hash ?? profileHash(profile),
          stage_cursor: durableStage.stageId,
          cursor_epoch: durableStage.epoch,
          loop_iteration: durableStage.loopIteration,
          role,
          slot_id: role,
          agent,
        });
        if (!result.ok || !result.record) return { ok: false, error: result.ok ? "dispatch authorization produced no record" : result.error };
        const captured: CapturedDispatchContext = {
          run_id: runId,
          dispatch_id: result.record.id,
          capability_id: capabilityId,
          ownership_epoch: readRunControl(opts.cwd).execution_claim?.ownership_epoch,
          rework_generation: current.rework_generation ?? 0,
          origin_session_id: opts.execution?.session_id ?? readRunControl(opts.cwd).execution_claim?.coordinator_session_id,
        };
        ctx.captured = captured;
        return { ok: true, dispatchId: result.record.id, captured };
      },
      complete: (dispatchId, output, outcome, artifactIds) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath);
        const runId = current.run_id;
        if (!runId) return { ok: false, error: "canonical run identity unavailable" };
        const capabilityId = current.dispatch_capability?.capability_id;
        if (!capabilityId) return { ok: false, error: "dispatch capability unavailable" };
        const result = completeDispatch(opts.cwd, {
          run_id: runId,
          token: durableStage.dispatchToken,
          capability_id: capabilityId,
          dispatch_id: dispatchId,
          run_key: current.run_key ?? current.branch,
          branch: current.branch,
          workflow: profile.name,
          profile_hash: current.profile_hash ?? profileHash(profile),
          stage_cursor: durableStage.stageId,
          cursor_epoch: durableStage.epoch,
          loop_iteration: durableStage.loopIteration,
          outcome,
          evidence: output || (outcome === "failed" ? "task failed" : "task completed"),
          artifact_ids: artifactIds,
        }, { runId });
        if (result.ok) ctx.state = result.state;
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      },
      advance: (evidence) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath);
        const runId = current.run_id;
        if (!runId) return { ok: false, error: "canonical run identity unavailable" };
        const capabilityId = current.dispatch_capability?.capability_id;
        if (!capabilityId) return { ok: false, error: "dispatch capability unavailable" };
        const result = advanceCursor(opts.cwd, {
          run_id: runId,
          token: durableStage.advanceToken,
          capability_id: capabilityId,
          run_key: current.run_key ?? current.branch,
          branch: current.branch,
          workflow: profile.name,
          profile_hash: current.profile_hash ?? profileHash(profile),
          stage_cursor: durableStage.stageId,
          cursor_epoch: durableStage.epoch,
          loop_iteration: durableStage.loopIteration,
          evidence,
        }, { runId });
        if (!result.ok) return { ok: false, error: `${result.error}: ${evidence}` };
        ctx.state = result.state;
        if (result.handoff) {
          durableStage = {
            stageId: result.state.stage_cursor,
            dispatchToken: result.handoff.dispatch_token,
            advanceToken: result.handoff.advance_token,
            epoch: result.handoff.cursor_epoch,
            loopIteration: result.handoff.loop_iteration,
          };
        }
        return { ok: true, handoff: result.handoff };
      },
    },
  };
  const outcomes = await walkProfile(runnableProfile, ctx);
  finalizeWorkflowRun(opts.cwd, initialState.run_id);
  return { classification, profile, outcomes: outcomes.map((o) => ({ stageId: o.stageId, status: o.status, note: o.note })), statePath };
}

/**
 * Resolve the terminal lifecycle from the state that is current under the
 * transaction lock. Kept as a named engine boundary so adapters and race
 * tests exercise the same fresh-state decision used by run().
 */
export function finalizeWorkflowRun(cwd: string, runId?: string): TeamState {
  if (runId) {
    const claim = readRunControl(cwd).execution_claim;
    return finalizeCanonicalRun(cwd, runId, claim?.run_id === runId ? claim.token : undefined);
  }
  throw new LifecycleError("run_selection_required", "finalizeWorkflowRun requires an explicit canonical run_id", { next_action: "select a canonical run before terminal finalization" });
 
}

function readState(path: string): TeamState {
  if (!path) throw new Error("state path missing");
  return JSON.parse(readFileSync(path, "utf8")) as TeamState;
}
