/**
 * Durable checkpoint decisions.
 *
 * Declared checkpoints (`stage.checkpoint`) are prompt/display metadata until
 * a decision is recorded here. The durable transition lives in `durable.ts`
 * (`recordCheckpointDecision`); this module provides the pure state helpers
 * used by the transition core and by tests: lookup, idempotent append, and
 * unresolved-checkpoint blocking.
 */

import type { CheckpointDecision, StageDef, TeamState } from "./types.js";

export function findCheckpointDecision(
  state: TeamState,
  stageId: string,
  checkpoint: string,
): CheckpointDecision | null {
  return (state.checkpoint_decisions ?? []).find(
    (decision) => decision.stage_id === stageId && decision.checkpoint === checkpoint,
  ) ?? null;
}

export function hasCheckpointDecision(state: TeamState, stageId: string, checkpoint: string): boolean {
  return findCheckpointDecision(state, stageId, checkpoint) !== null;
}

/**
 * Idempotent append: recording an identical decision for the same
 * (stage, checkpoint) is a no-op; a different decision replaces the prior
 * record (the latest user/model decision wins).
 */
export function appendCheckpointDecision(
  state: TeamState,
  decision: CheckpointDecision,
): TeamState {
  const existing = state.checkpoint_decisions ?? [];
  const rest = existing.filter(
    (candidate) => !(candidate.stage_id === decision.stage_id && candidate.checkpoint === decision.checkpoint),
  );
  return { ...state, checkpoint_decisions: [...rest, decision] };
}

/**
 * Advance-blocking check: a stage that declares a checkpoint may not leave
 * `done` without a durable decision record. Returns the error text, or null
 * when the stage has no checkpoint or already has a decision.
 */
export function unresolvedCheckpointError(stage: StageDef, state: TeamState): string | null {
  if (!stage.checkpoint) return null;
  if (hasCheckpointDecision(state, stage.id, stage.checkpoint)) return null;
  return `checkpoint '${stage.checkpoint}' for stage '${stage.id}' is unresolved: record a decision (interactive or autonomous) before advancing`;
}
