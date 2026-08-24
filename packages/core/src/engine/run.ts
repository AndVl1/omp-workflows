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
 * Autonomy contract (RC2+): `classification` carries the MODEL decision
 * (`classification.autonomous`) and is authoritative. When it is supplied,
 * type/complexity/confidence/autonomous must all be present — the engine
 * FAILS CLOSED rather than silently filling the gaps from keyword guesses.
 * `keywordClassify` remains only for legacy callers that run without a
 * model classification; it cannot decide autonomy (the caller's `autonomous`
 * option is used verbatim, never defaulted).
 */

import { readFileSync } from "node:fs";
import { loadAllProfiles, profileHash, resolveWorkflow, selectProfile } from "./profile.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveScope, type ScopeFlags } from "./scope.js";
import { writeState, setStageStatus, setPause, resolveState, reopenFromFeedback, type ResolvedState } from "./state.js";
import { authorizeDispatch, completeDispatch, advanceCursor, createCapability, recordCheckpointDecision } from "./durable.js";
import { hasCheckpointDecision } from "./checkpoints.js";
import { keywordClassify } from "./classify.js";
import type { Classification, Complexity, Confidence, Profile, RoleConfig, TaskType, TeamState, WorkflowName } from "./types.js";
import { walkProfile, resolveStageDispatchSlots, type StageContext, type TaskCaller } from "./stage.js";
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
  /** Resume prior state after user feedback, preserving artifacts/history. */
  continuation?: { feedback: string; stageId: string };
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
    const expected = resolveWorkflow(model.type, model.complexity, model.autonomous);
    if (
      model.workflow !== undefined &&
      model.workflow !== expected &&
      (model.type === "SPEC" || model.type === "REGRESS" || model.type === "LECTURE_RESEARCH")
    ) {
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
  return {
    type: base.type,
    complexity: base.complexity,
    confidence: base.confidence,
    autonomous: opts.autonomous,
    workflow: resolveWorkflow(base.type, base.complexity, opts.autonomous),
  };
}

export type WorkflowPrepareOptions = Pick<RunOptions, "task" | "cwd" | "branch" | "autonomous" | "classification" | "files" | "issue" | "continuation">;

export interface PreparedWorkflowState {
  config: RoleConfig;
  profile: Profile;
  flags: ScopeFlags;
  classification: Classification;
  state: TeamState;
  statePath: string;
  artifactsDir: string;
  stateTarget: { target?: ResolvedState };
  expectedRoster: (stage: NonNullable<Profile["stages"][number]>) => Array<{ role: string; agent: string }>;
}

/**
 * Persist a new PHASE-0 classification through the engine-owned state writer.
 * The interactive orchestrator must call this helper through `workflow_prepare`
 * instead of editing canonical `.work-state` files directly.
 */
export function prepareWorkflowState(opts: WorkflowPrepareOptions): PreparedWorkflowState {
  const config = resolveConfig(opts.cwd);
  const profiles = loadAllProfiles();
  const existing = resolveState(opts.cwd, opts.branch);
  const isContinuation = Boolean(opts.continuation);
  if (existing.invalid) throw new Error("workflow state is invalid or unsafe");
  if (isContinuation && (!existing.state || existing.isStale)) {
    throw new Error(`cannot continue workflow: no non-stale state for branch ${opts.branch}`);
  }
  if (!isContinuation && existing.state && !existing.isStale) {
    throw new Error("workflow state already exists for this branch; use continuation mode");
  }

  const persistedClassification = isContinuation ? existing.state?.classification : undefined;
  const classification = persistedClassification ?? resolveClassification(opts);
  const profile = persistedClassification
    ? profiles.find((candidate) => candidate.name === persistedClassification.workflow)
    : selectProfile(profiles, classification);
  if (!profile) throw new Error(`no profile matches classification ${JSON.stringify(classification)}`);

  const flags = opts.files !== undefined
    ? resolveScope(opts.files, config)
    : isContinuation && existing.state?.scope
      ? existing.state.scope
      : resolveScope([], config);
  const resolveSlots = (stage: NonNullable<Profile["stages"][number]>): DispatchSlot[] =>
    resolveStageDispatchSlots(stage, { cwd: opts.cwd, flags, resolveDevAgent: () => flags.dev_agent });
  const expectedRoster = (stage: NonNullable<Profile["stages"][number]>): Array<{ role: string; agent: string }> =>
    resolveSlots(stage).map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) }));

  const reopened = opts.continuation
    ? reopenFromFeedback(existing.state!, opts.continuation.feedback, opts.continuation.stageId)
    : null;
  const state: TeamState = reopened
    ? { ...reopened, dispatch_capability: undefined, cursor_epoch: undefined, scope: flags, policy: { ...(reopened.policy ?? {}), strict_orchestrator: true } }
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
        run_key: opts.branch,
        updated_at: new Date().toISOString(),
      } satisfies TeamState;
  const stateTarget = isContinuation ? { target: existing } : {};
  const { statePath, artifactsDir } = writeState(opts.cwd, state, stateTarget);
  return { config, profile, flags, classification, state, statePath, artifactsDir, stateTarget, expectedRoster };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const prepared = prepareWorkflowState(opts);
  const { config, profile, flags, classification, state: initialState, statePath, artifactsDir, stateTarget, expectedRoster } = prepared;
  const completed = new Set(initialState.stages.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id));
  const runnableProfile = completed.size === 0 ? profile : { ...profile, stages: profile.stages.filter((s) => !completed.has(s.id)) };
  let durableStage: { stageId: string; dispatchToken: string; advanceToken: string; epoch: string } | null = null;
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
      const current = readState(statePath);
      // A durable advance (normal or loop re-entry) already armed this stage
      // with a ready capability and the handoff secrets live in durableStage.
      // Reuse it so loop re-entry keeps the fresh epoch issued by
      // advanceCursor; do not re-mint a second capability for the same stage.
      const armed = current.dispatch_capability;
      if (
        durableStage &&
        durableStage.stageId === stageId &&
        armed?.issued_for?.stage_cursor === stageId &&
        (armed.status === "ready" || armed.status === "dispatched")
      ) {
        const next = setStageStatus(current, stageId, "in_progress", opts.cwd);
        ctx.state = next;
        writeState(opts.cwd, next, stateTarget);
        return;
      }
      const stage = profile.stages.find((candidate) => candidate.id === stageId);
      // A capability is bound for EVERY stage type so the durable advance
      // (checkpoint enforcement, autonomous decision recording, atomic
      // arming of the next stage) is available for orchestrator/bash/none
      // stages exactly as it is for single/consilium. Non-dispatch stages
      // get kind "none" with an empty roster, mirroring beginCapability.
      const kind: "single" | "consilium" | "none" = stage?.type === "single" ? "single" : stage?.type === "consilium" ? "consilium" : "none";
      const next = setStageStatus(current, stageId, "in_progress", opts.cwd);
      const issued = stage
        ? createCapability({ run_key: next.run_key ?? next.branch, branch: next.branch, workflow: profile.name, profile_hash: profileHash(profile), stage_cursor: stage.id, kind, expected_roster: kind === "none" ? [] : expectedRoster(stage) })
        : null;
      const nextState: TeamState = issued
        ? { ...next, run_key: next.run_key ?? next.branch, cursor_epoch: issued.state.issued_for!.cursor_epoch, profile_hash: profileHash(profile), dispatch_capability: issued.state }
        : { ...next, cursor_epoch: undefined, dispatch_capability: undefined };
      ctx.state = nextState;
      if (issued) durableStage = { stageId, dispatchToken: issued.dispatch_token, advanceToken: issued.advance_token, epoch: issued.state.issued_for!.cursor_epoch };
      else durableStage = null;
      writeState(opts.cwd, nextState, stateTarget);
    },
    onStageComplete: (stageId, status) => {
      const current = readState(statePath);
      const next = setStageStatus(current, stageId, status, opts.cwd);
      ctx.state = next;
      writeState(opts.cwd, next, stateTarget);
    },
    log: opts.log ?? (() => undefined),
    resolveDevAgent: () => flags.dev_agent,
    durable: {
      authorize: (role, agent) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath);
        const r = authorizeDispatch(opts.cwd, { token: durableStage.dispatchToken, capability_id: current.dispatch_capability?.capability_id ?? "", run_key: current.run_key ?? current.branch, branch: current.branch, workflow: profile.name, profile_hash: current.profile_hash ?? profileHash(profile), stage_cursor: durableStage.stageId, cursor_epoch: durableStage.epoch, role, agent });
        if (r.ok) ctx.state = r.state;
        return r.ok && r.record ? { ok: true, dispatchId: r.record.id } : { ok: false, error: r.ok ? "missing dispatch record" : r.error };
      },
      complete: (dispatchId, output, outcome, artifactIds) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath);
        const r = completeDispatch(opts.cwd, { token: durableStage.dispatchToken, capability_id: current.dispatch_capability?.capability_id ?? "", dispatch_id: dispatchId, run_key: current.run_key ?? current.branch, branch: current.branch, workflow: profile.name, profile_hash: current.profile_hash ?? profileHash(profile), stage_cursor: durableStage.stageId, cursor_epoch: durableStage.epoch, outcome, evidence: output || (outcome === "failed" ? "task failed" : "task completed"), artifact_ids: artifactIds });
        if (r.ok) ctx.state = r.state;
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      advance: (evidence) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath);
        // Autonomous runs record the declared auto-decision for unresolved
        // checkpoints before advance; interactive runs leave them unresolved
        // so advance fails closed and the owning session records the user's
        // decision via workflow_checkpoint.
        const stageDef = profile.stages.find((candidate) => candidate.id === durableStage!.stageId);
        if (stageDef?.checkpoint && current.classification.autonomous && !hasCheckpointDecision(current, stageDef.id, stageDef.checkpoint)) {
          const recorded = recordCheckpointDecision(opts.cwd, {
            token: durableStage.advanceToken,
            capability_id: current.dispatch_capability?.capability_id ?? "",
            run_key: current.run_key ?? current.branch,
            branch: current.branch,
            workflow: profile.name,
            profile_hash: current.profile_hash ?? profileHash(profile),
            stage_cursor: durableStage.stageId,
            cursor_epoch: durableStage.epoch,
            checkpoint: stageDef.checkpoint,
            mode: "autonomous",
            decision: "proceed",
            actor: "orchestrator",
            rationale: stageDef.autonomous ?? "autonomous mode",
          });
          if (!recorded.ok) return { ok: false, error: `checkpoint record failed: ${recorded.error}` };
          ctx.state = recorded.state;
        }
        const r = advanceCursor(opts.cwd, { token: durableStage.advanceToken, capability_id: current.dispatch_capability?.capability_id ?? "", run_key: current.run_key ?? current.branch, branch: current.branch, workflow: profile.name, profile_hash: current.profile_hash ?? profileHash(profile), stage_cursor: durableStage.stageId, cursor_epoch: durableStage.epoch, evidence });
        if (!r.ok) return { ok: false, error: `${r.error}: ${evidence}` };
        ctx.state = r.state;
        if (r.handoff) durableStage = { stageId: r.state.stage_cursor, dispatchToken: r.handoff.dispatch_token, advanceToken: r.handoff.advance_token, epoch: r.handoff.cursor_epoch };
        return { ok: true, handoff: r.handoff };
      },
    },
  };
  opts.log?.(`walking profile: ${profile.name} (${runnableProfile.stages.length} stages)`);
  const outcomes = await walkProfile(profile, ctx);
  const final = readState(statePath);
  const done = final.stages.every((s) => s.status === "done" || s.status === "skipped");
  // A loop-exhaustion pause (needs_human/failed) is the durable outcome of
  // the run; do not overwrite it with a generic status.
  const terminal = final.pause.kind === "needs_human" || final.pause.kind === "failed"
    ? final
    : setPause(final, done ? "done" : "failed", done ? "" : "one or more stages failed");
  writeState(opts.cwd, terminal, stateTarget);
  return { classification, profile, outcomes: outcomes.map((o) => ({ stageId: o.stageId, status: o.status, note: o.note })), statePath };
}

function readState(path: string): TeamState {
  if (!path) throw new Error("state path missing");
  return JSON.parse(readFileSync(path, "utf8")) as TeamState;
}
