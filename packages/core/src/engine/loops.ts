/**
 * Bounded-loop state machine helpers.
 *
 * The durable re-entry transition lives in `advanceCursor` (the single
 * transition core shared by workflow tools and the legacy interpreter); this
 * module provides the pure decisions: exhaustion mapping, re-entry budget,
 * iteration history, and the resolved back-to stage.
 */

import type { LoopIterationRecord, LoopState, Profile, StageDef, TeamState } from "./types.js";

/** Map a shipped `on_exhausted` value to the durable pause kind. */
export function loopExhaustionKind(onExhausted: string): "needs_human" | "failed" {
  return onExhausted === "failed" ? "failed" : "needs_human";
}

/** The active loop state for a stage, or null when none was started. */
export function loopStateFor(state: TeamState, stageId: string): LoopState | null {
  const loop = state.loop_state;
  return loop && loop.stage_id === stageId ? loop : null;
}

/**
 * Re-entry budget: `reentries` counts loop-backs performed and the active
 * execution is `reentries + 1`. `max_iterations` is therefore the maximum
 * number of real executions, including the first pass: a failed final
 * iteration exhausts instead of creating an extra synthetic pass.
 */
export function loopReentryDecision(
  loop: LoopState | null,
  maxIterations: number,
): { reentries: number; exhausted: boolean } {
  const reentries = loop?.reentries ?? 0;
  return { reentries, exhausted: reentries + 1 >= maxIterations };
}

/** The stage to re-enter, verified against the profile. */
export function resolveBackToStage(profile: Profile, backTo: string): StageDef | null {
  return profile.stages.find((stage) => stage.id === backTo) ?? null;
}

export type LoopIterationResult = { ok: true; iteration: number } | { ok: false; error: string };

/**
 * The 1-based loop iteration a stage currently executes in.
 *
 * The first passing iteration of every stage is `1`. While a bounded loop is
 * `running`, every stage inside the `back_to … loop owner` window executes
 * in iteration `loop_state.reentries + 1` — re-entry rotates the whole
 * window, so checkpoints recorded in a prior iteration can neither satisfy
 * nor deadlock a re-entered stage. A loop state that does not actually
 * re-enter the queried stage, or a malformed re-entry counter, fails closed.
 */
export function loopIterationForStage(state: TeamState, profile: Profile, stageId: string): LoopIterationResult {
  const stage = profile.stages.find((candidate) => candidate.id === stageId);
  if (!stage) return { ok: false, error: `stage '${stageId}' is not present in the workflow profile` };
  const loop = state.loop_state;
  if (!loop || loop.status !== "running") return { ok: true, iteration: 1 };
  const owner = profile.stages.find((candidate) => candidate.id === loop.stage_id);
  if (!owner?.loop || owner.loop.back_to !== loop.back_to || !profile.stages.some((candidate) => candidate.id === loop.back_to)) {
    return { ok: false, error: `durable loop state for stage '${loop.stage_id}' is inconsistent with the workflow profile` };
  }
  if (!Number.isInteger(loop.reentries) || loop.reentries < 0) {
    return { ok: false, error: `durable loop state for stage '${loop.stage_id}' has a malformed reentry counter` };
  }
  const ownerIndex = profile.stages.indexOf(owner);
  const backToIndex = profile.stages.findIndex((candidate) => candidate.id === loop.back_to);
  const stageIndex = profile.stages.indexOf(stage);
  const windowStart = Math.min(ownerIndex, backToIndex);
  const windowEnd = Math.max(ownerIndex, backToIndex);
  if (stageIndex >= windowStart && stageIndex <= windowEnd) {
    return { ok: true, iteration: loop.reentries + 1 };
  }
  return { ok: true, iteration: 1 };
}

/**
 * Stage ids that belong to the currently running loop window when execution
 * resumes after a loop-back. Completed status is historical for these stages:
 * the next real iteration must still walk them from `back_to` through the loop
 * owner. Upstream stages and downstream stages remain subject to the normal
 * completed-stage filter.
 */
export function loopReentryStageIds(profile: Profile, state: TeamState): Set<string> {
  const loop = state.loop_state;
  if (!loop || loop.status !== "running") return new Set();
  const ownerIndex = profile.stages.findIndex((stage) => stage.id === loop.stage_id);
  const backToIndex = profile.stages.findIndex((stage) => stage.id === loop.back_to);
  const cursorIndex = profile.stages.findIndex((stage) => stage.id === state.stage_cursor);
  if (
    ownerIndex < 0
    || backToIndex < 0
    || cursorIndex < 0
    || cursorIndex < Math.min(ownerIndex, backToIndex)
    || cursorIndex > Math.max(ownerIndex, backToIndex)
  ) return new Set();
  return new Set(profile.stages
    .slice(Math.min(ownerIndex, backToIndex), Math.max(ownerIndex, backToIndex) + 1)
    .map((stage) => stage.id));
}

/** Fresh history entry for one loop-back. */
export function loopIterationRecord(
  iteration: number,
  fromEpoch: string,
  toEpoch: string,
  untilSatisfied: boolean,
): LoopIterationRecord {
  return { iteration, from_epoch: fromEpoch, to_epoch: toEpoch, until_satisfied: untilSatisfied, at: new Date().toISOString() };
}
