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

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const WORK_STATE_DIR = ".work-state";

interface AgentStartContext {
  cwd: string;
  run_id?: string;
}

interface StageEntry {
  id: string;
  status?: "pending" | "in_progress" | "done" | "skipped" | "failed";
}

export function monotonicGate(_event: unknown, ctx: AgentStartContext): { block?: boolean; reason?: string } | void {
  const statePath = resolveStatePath(ctx.cwd, ctx.run_id);
  if (!statePath) return;
  let state: { stages?: StageEntry[] };
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as typeof state;
  } catch {
    return;
  }
  if (!Array.isArray(state.stages) || state.stages.length === 0) return;
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

function resolveStatePath(cwd: string, runId?: string): string | null {
  if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) return null;
  const canonical = join(resolve(cwd, WORK_STATE_DIR), "runs", runId, "state.json");
  return existsSync(canonical) ? canonical : null;
}
