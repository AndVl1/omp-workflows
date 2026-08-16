/**
 * Definition-of-Done backstop. Replaces claude-plugin's `dod-gate.sh`
 * Stop hook.
 *
 * Blocks a done-claim (returns `{ decision: "block", reason }` from
 * `session_stop`) when the DoD artifact has unmet or evidence-less items.
 *
 * Allows Stop in every legitimate pause:
 *   - no JSON state / no .work-state
 *   - stale state (branch != current)
 *   - pause.kind in background_wait | user_checkpoint | needs_human | failed
 *   - override marker .work-state/.dod-override present
 *   - workflow in research | review | emergency (no implementation phase)
 *   - not claiming done yet (cursor not at summary AND pause.kind != done)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const WORK_STATE_DIR = ".work-state";

interface SessionStopEvent {
  stop_hook_active?: boolean;
}

interface SessionStopContext {
  cwd: string;
}

interface DoD {
  items: Array<{ id: string; status?: string; evidence?: string }>;
}

interface TeamState {
  classification?: { workflow?: string };
  pause?: { kind?: string };
  stage_cursor?: string;
  branch?: string;
}

export function dodBackstop(event: SessionStopEvent, ctx: SessionStopContext): { decision: "block"; reason: string } | { continue: true } | void {
  if (event.stop_hook_active) return;
  const statePath = resolveStatePath(ctx.cwd);
  if (!statePath) return;

  let state: TeamState;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
  } catch {
    return;
  }

  if (existsSync(join(ctx.cwd, WORK_STATE_DIR, ".dod-override"))) return;

  const workflow = state.classification?.workflow;
  if (workflow === "research" || workflow === "review" || workflow === "emergency") return;

  const pause = state.pause?.kind ?? "none";
  if (pause === "background_wait" || pause === "user_checkpoint" || pause === "needs_human" || pause === "failed") return;

  const cursor = state.stage_cursor;
  const claimingDone = pause === "done" || cursor === "summary";
  if (!claimingDone) return;
  const pendingDispatches = (state as TeamState & { dispatch_capability?: { dispatches?: Array<{ id: string; status?: string }> } }).dispatch_capability?.dispatches?.filter((d) => d.status === "authorized" || d.status === "running") ?? [];
  if (pendingDispatches.length > 0) {
    return {
      decision: "block",
      reason: `Durable join incomplete: ${pendingDispatches.length} dispatch(es) still authorized/running (${pendingDispatches.map((d) => d.id).join(", ")}). Reconcile terminal tool_result outcomes before stopping.`,
    };
  }
  const dodPath = resolveDoDPath(statePath);
  const dod = readDoD(dodPath);
  if (!dod) {
    return {
      decision: "block",
      reason: `DoD: task is claiming done but ${dodPath} is missing. Write the Definition of Done (acceptance criteria + verify_method per item, fixed during exploration/diagnose). To pause instead, set pause.kind to background_wait | user_checkpoint | needs_human | failed. To override deliberately: touch .work-state/.dod-override`,
    };
  }
  if (dod.items.length === 0) {
    return {
      decision: "block",
      reason: "DoD: empty Definition of Done at done-claim. Write at least one criterion before claiming done.",
    };
  }
  const pending = dod.items.filter((it) => it.status !== "met" || !it.evidence);
  if (pending.length > 0) {
    return {
      decision: "block",
      reason: `DoD: ${pending.length} item(s) unmet or evidence-less: ${pending.map((p) => p.id).join(", ")}. Close each with non-empty evidence, or set pause.kind to background_wait | user_checkpoint | needs_human | failed for an intentional pause. Override: touch .work-state/.dod-override`,
    };
  }
  return { continue: true };
}

function resolveStatePath(cwd: string): string | null {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) return null;
  const active = join(wsDir, ".active-feature");
  if (existsSync(active)) {
    const slug = readFileSync(active, "utf8").trim();
    if (slug) {
      const path = join(wsDir, "features", slug, "state.json");
      if (existsSync(path)) return path;
    }
  }
  const legacy = join(wsDir, "team-state.json");
  if (existsSync(legacy)) return legacy;
  return null;
}

function resolveDoDPath(statePath: string): string {
  // artifacts sit next to state.json: <dir>/state.json -> <dir>/artifacts/dod.json
  const dir = statePath.replace(/state\.json$/, "").replace(/team-state\.json$/, "");
  return `${dir}artifacts/dod.json`;
}

function readDoD(path: string): DoD | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DoD;
  } catch {
    return null;
  }
}
