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

import { readFileSync } from "node:fs";
import { loadAllProfiles, profileHash, resolveWorkflow, selectProfile } from "./profile.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveScope, type ScopeFlags } from "./scope.js";
import {
  DETACHED_BRANCH,
  NO_GIT_BRANCH,
  resolveActiveBranch,
  reopenFromFeedback,
  resolveState,
  setStageStatus,
  updateStateAtomically,
} from "./state.js";
import { authorizeDispatch, completeDispatch, advanceCursor, createCapability, type IssuedCapability } from "./durable.js";
import { resolveCheckpointDeclaration } from "./checkpoints.js";
import { loopIterationForStage } from "./loops.js";
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

export type WorkflowPrepareOptions = Pick<RunOptions, "task" | "cwd" | "branch" | "autonomous" | "classification" | "files" | "issue" | "continuation">;

export interface PreparedWorkflowState {
  config: RoleConfig;
  profile: Profile;
  flags: ScopeFlags;
  classification: Classification;
  state: TeamState;
  statePath: string;
  artifactsDir: string;
  expectedRoster: (stage: NonNullable<Profile["stages"][number]>) => Array<{ role: string; agent: string }>;
}

/**
 * Persist a new PHASE-0 classification through the engine-owned state writer.
 * The interactive orchestrator must call this helper through `workflow_prepare`
 * instead of editing canonical `.work-state` files directly.
 */
export function prepareWorkflowState(opts: WorkflowPrepareOptions): PreparedWorkflowState {
  // Host git state is the ingress authority. Reject detached/non-git roots
  // and model-supplied branch drift before resolveState/updateStateAtomically
  // can create `.work-state` or write an active pointer.
  const activeBranch = resolveActiveBranch(opts.cwd);
  if (activeBranch === DETACHED_BRANCH) {
    throw new Error("cannot prepare workflow state from detached HEAD");
  }
  if (activeBranch === NO_GIT_BRANCH) {
    throw new Error("cannot prepare workflow state outside a git worktree");
  }
  if (opts.branch !== activeBranch) {
    throw new Error(`workflow branch mismatch: host is '${activeBranch}', request supplied '${opts.branch}'`);
  }
  const config = resolveConfig(opts.cwd);
  const profiles = loadAllProfiles();
  const existing = resolveState(opts.cwd, activeBranch);
  const isContinuation = Boolean(opts.continuation);
  if (existing.invalid) throw new Error("workflow state is invalid or unsafe");
  if (isContinuation && (!existing.state || existing.isStale)) {
    throw new Error(`cannot continue workflow: no non-stale state for branch ${activeBranch}`);
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

  // The classification write is ONE cross-process transaction: the
  // already-exists gate and the continuation gate run against the freshly
  // persisted state under the workspace lock, never a pre-lock snapshot.
  const outcome = updateStateAtomically<{ state: TeamState }>(opts.cwd, (snapshot) => {
    if (isContinuation) {
      if (!snapshot.state || snapshot.target.isStale) {
        return { op: "fail", code: "state_missing", error: `cannot continue workflow: no non-stale state for branch ${activeBranch}` };
      }
      const reopened = reopenFromFeedback(snapshot.state, opts.continuation!.feedback, opts.continuation!.stageId);
      const next: TeamState = { ...reopened, scope: flags, policy: { ...(reopened.policy ?? {}), strict_orchestrator: true } };
      // Continuation re-arms stages through the durable transitions: the prior
      // run's capability mirrors are cleared by DELETING their keys — an own
      // undefined value would fail persisted-state normalization and every
      // continuation of a durable run would throw at write time.
      delete next.dispatch_capability;
      delete next.cursor_epoch;
      return { op: "commit", state: next, value: { state: next } };
    }
    if (snapshot.state && !snapshot.target.isStale) {
      return { op: "fail", code: "state_conflict", error: "workflow state already exists for this branch; use continuation mode" };
    }
    const fresh: TeamState = {
      schema: 1,
      branch: activeBranch,
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
      run_key: activeBranch,
      updated_at: new Date().toISOString(),
    } satisfies TeamState;
    return { op: "commit", state: fresh, value: { state: fresh } };
  }, { branch: activeBranch });
  if (!outcome.ok) throw new Error(outcome.error);
  if (!outcome.value) throw new Error("workflow state transaction completed without a result");
  // The prepared state is the COMMITTED, normalized and revision-stamped
  // state on disk — never the pre-normalization mutation output.
  const state = outcome.committed && outcome.state ? outcome.state : outcome.value.state;
  // A fresh run can commit either from an absent target or by retargeting a
  // stale active feature to the current branch. In both cases the
  // transaction's resolved target does not describe the committed file, so
  // resolve it again after the commit.
  const committedTarget = outcome.target.statePath && !outcome.target.isStale
    ? outcome.target
    : resolveState(opts.cwd, activeBranch);
  const statePath = committedTarget.statePath ?? "";
  const artifactsDir = committedTarget.artifactsDir ?? "";
  return { config, profile, flags, classification, state, statePath, artifactsDir, expectedRoster };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const prepared = prepareWorkflowState(opts);
  const { config, profile, flags, classification, state: initialState, statePath, artifactsDir, expectedRoster } = prepared;
  const completed = new Set(initialState.stages.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id));
  const runnableProfile = completed.size === 0 ? profile : { ...profile, stages: profile.stages.filter((s) => !completed.has(s.id)) };
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
          (armed.status === "ready" || armed.status === "dispatched")
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
          kind,
          expected_roster: kind === "none" ? [] : expectedRoster(stage),
          loop_iteration: iteration.iteration,
          checkpoint_policy_hash: declaration.declaration?.policy_hash ?? null,
        });
        const nextState: TeamState = {
          ...next,
          run_key: next.run_key ?? next.branch,
          cursor_epoch: issued.state.issued_for!.cursor_epoch,
          profile_hash: persistedProfileHash,
          dispatch_capability: issued.state,
        };
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
      });
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
      });
      if (!outcome.ok) throw new Error(outcome.error);
      ctx.state = outcome.state ?? ctx.state;
    },
    log: opts.log ?? (() => undefined),
    resolveDevAgent: () => flags.dev_agent,
    durable: {
      authorize: (role, agent) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath);
        const r = authorizeDispatch(opts.cwd, { token: durableStage.dispatchToken, capability_id: current.dispatch_capability?.capability_id ?? "", run_key: current.run_key ?? current.branch, branch: current.branch, workflow: profile.name, profile_hash: current.profile_hash ?? profileHash(profile), stage_cursor: durableStage.stageId, cursor_epoch: durableStage.epoch, loop_iteration: durableStage.loopIteration, role, agent });
        if (r.ok) ctx.state = r.state;
        return r.ok && r.record ? { ok: true, dispatchId: r.record.id } : { ok: false, error: r.ok ? "missing dispatch record" : r.error };
      },
      complete: (dispatchId, output, outcome, artifactIds) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath);
        const r = completeDispatch(opts.cwd, { token: durableStage.dispatchToken, capability_id: current.dispatch_capability?.capability_id ?? "", dispatch_id: dispatchId, run_key: current.run_key ?? current.branch, branch: current.branch, workflow: profile.name, profile_hash: current.profile_hash ?? profileHash(profile), stage_cursor: durableStage.stageId, cursor_epoch: durableStage.epoch, loop_iteration: durableStage.loopIteration, outcome, evidence: output || (outcome === "failed" ? "task failed" : "task completed"), artifact_ids: artifactIds });
        if (r.ok) ctx.state = r.state;
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      advance: (evidence) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath);
        // advanceCursor performs checkpoint resolution, pause selection and
        // the cursor move inside its own fresh-state transaction. A decision
        // recorded after this adapter read is therefore observed rather than
        // overwritten by a stale pause decision.
        const r = advanceCursor(opts.cwd, {
          token: durableStage.advanceToken,
          capability_id: current.dispatch_capability?.capability_id ?? "",
          run_key: current.run_key ?? current.branch,
          branch: current.branch,
          workflow: profile.name,
          profile_hash: current.profile_hash ?? profileHash(profile),
          stage_cursor: durableStage.stageId,
          cursor_epoch: durableStage.epoch,
          loop_iteration: durableStage.loopIteration,
          evidence,
        });
        if (!r.ok) return { ok: false, error: `${r.error}: ${evidence}` };
        ctx.state = r.state;
        if (r.handoff) durableStage = { stageId: r.state.stage_cursor, dispatchToken: r.handoff.dispatch_token, advanceToken: r.handoff.advance_token, epoch: r.handoff.cursor_epoch, loopIteration: r.handoff.loop_iteration };
        return { ok: true, handoff: r.handoff };
      },
    },
  };
  opts.log?.(`walking profile: ${profile.name} (${runnableProfile.stages.length} stages)`);
  const outcomes = await walkProfile(profile, ctx);
  finalizeWorkflowRun(opts.cwd);
  return { classification, profile, outcomes: outcomes.map((o) => ({ stageId: o.stageId, status: o.status, note: o.note })), statePath };
}

/**
 * Resolve the terminal lifecycle from the state that is current under the
 * transaction lock. Kept as a named engine boundary so adapters and race
 * tests exercise the same fresh-state decision used by run().
 */
export function finalizeWorkflowRun(cwd: string): TeamState {
  const terminal = updateStateAtomically(cwd, (snapshot) => {
    if (!snapshot.state) return { op: "fail", code: "state_missing", error: "workflow state missing" };
    const current = snapshot.state;
    const resumablePause = current.pause.kind === "user_checkpoint"
      || current.pause.kind === "needs_human"
      || current.pause.kind === "background_wait"
      || current.pause.kind === "failed";
    if (resumablePause) return { op: "discard" };
    const done = current.stages.every((stage) => stage.status === "done" || stage.status === "skipped");
    return {
      op: "commit",
      state: {
        ...current,
        pause: { kind: done ? "done" : "failed", reason: done ? "" : "one or more stages failed" },
        updated_at: new Date().toISOString(),
      },
    };
  });
  if (!terminal.ok) throw new Error(terminal.error);
  if (!terminal.state) throw new Error("workflow state missing after terminal transaction");
  return terminal.state;
}

function readState(path: string): TeamState {
  if (!path) throw new Error("state path missing");
  return JSON.parse(readFileSync(path, "utf8")) as TeamState;
}
