/**
 * Monotonic stage gate (P4). Replaces the second half of claude-plugin's
 * `validate-state.sh` hook.
 *
 * The team-state.json `stages[]` array must be monotonic — a `pending`
 * stage must not precede a `done` or `in_progress` stage. Mark deliberately
 * skipped stages `skipped`, never `pending`.
 *
 * Wired to `before_agent_start`.
 */

import { PinnedProjectRoot } from "../specification/pinned-root.js";
import { resolveActiveStatePinned } from "../engine/state.js";

interface AgentStartContext {
  cwd: string;
}

interface StageEntry {
  id: string;
  status?: "pending" | "in_progress" | "done" | "skipped" | "failed";
}

export function monotonicGate(
  _event: unknown,
  ctx: AgentStartContext,
  borrowedState?: { stages?: StageEntry[] },
): { block?: boolean; reason?: string } | void {
  let state: { stages?: StageEntry[] } | null = borrowedState ?? null;
  if (!state) {
    const pinnedRoot = PinnedProjectRoot.open(ctx.cwd);
    if (!pinnedRoot) return;
    try {
      state = resolveActiveStatePinned(ctx.cwd, pinnedRoot).state;
    } finally {
      pinnedRoot.close();
    }
  }
  if (!state || !Array.isArray(state.stages) || state.stages.length === 0) return;
  const statuses = state.stages.map((s) => s.status ?? "pending");
  const firstPending = statuses.indexOf("pending");
  if (firstPending === -1) return;
  const after = statuses.slice(firstPending + 1).filter((s) => s === "done" || s === "in_progress");
  if (after.length > 0) {
    const stageId = state.stages[firstPending]?.id ?? "?";
    return {
      block: true,
      reason: `BLOCK (P4): stage progress is not monotonic — stage ${stageId} is pending while a later stage is done/in_progress. Mark skipped stages 'skipped', not 'pending'.`,
    };
  }
}
