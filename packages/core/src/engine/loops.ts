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
 * Re-entry budget: `reentries` counts loop-backs performed. A loop is
 * exhausted when the `until` expression still fails and re-entries have
 * already reached `max_iterations` (i.e. `max_iterations` re-entries are
 * allowed before escalation).
 */
export function loopReentryDecision(
  loop: LoopState | null,
  maxIterations: number,
): { reentries: number; exhausted: boolean } {
  const reentries = loop?.reentries ?? 0;
  return { reentries, exhausted: reentries >= maxIterations };
}

/** The stage to re-enter, verified against the profile. */
export function resolveBackToStage(profile: Profile, backTo: string): StageDef | null {
  return profile.stages.find((stage) => stage.id === backTo) ?? null;
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
