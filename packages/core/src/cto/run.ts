/**
 * CTO run entry point (two-layer contract, R12).
 *
 * The engine never executes teams itself (OMP custom-TS commands have no
 * `task` surface) — `runCto` builds + validates the TeamPlan, persists the
 * initial CtoState, and returns the plan for the CTO agent to execute
 * mechanically through its own `task`/`hub`. Every step the agent takes is
 * checked against this state by the engine helpers.
 */

import { buildTeamPlan, validateDecompositionDepth, type PlanTeamInput } from "./plan.js";
import { newCtoState, writeCtoState } from "./state.js";
import type { CtoState, TeamDef, TeamPlan } from "./types.js";

export interface RunCtoOptions {
  task: string;
  cwd: string;
  branch: string;
  autonomous: boolean;
  /** Proposed decomposition (from the CTO agent / consumer orchestrator). */
  teams: PlanTeamInput[];
  /** TeamDef registry (consumer-owned). */
  defs: Record<string, TeamDef> | Map<string, TeamDef>;
  /** Optional: sub-profile depth (team stages inside each profile), for the depth cap. */
  profileDepth?: (profile: string) => number;
  /** Standby runs are adoptable cross-session (inbox continuity). */
  standby?: boolean;
  /** Session owning this interactive task run (foreign sessions do not amend it). */
  owner_session?: string;
  log?: (line: string) => void;
}

export type RunCtoResult =
  | { ok: true; plan: TeamPlan; state: CtoState; statePath: string }
  | { ok: false; reason: string };

let runSeq = 0;

/** Slug id: `<task-slug>-<timestamp-ms>-<seq>`, unique per run. */
export function ctoRunId(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 23).replace(/[:T.]/g, "-");
  runSeq += 1;
  return `${slug || "task"}-${stamp}-${runSeq.toString(36)}`;
}

export function runCto(opts: RunCtoOptions): RunCtoResult {
  const built = buildTeamPlan({ id: ctoRunId(opts.task), task: opts.task, teams: opts.teams }, opts.defs);
  if (!built.ok) return built;

  const depth = validateDecompositionDepth(built.plan, opts.profileDepth);
  if (!depth.ok) return { ok: false, reason: depth.reason };

  const state = newCtoState({
    id: built.plan.id,
    task: opts.task,
    branch: opts.branch,
    autonomous: opts.autonomous,
    plan: built.plan,
    ...(opts.standby === true ? { standby: true } : {}),
    ...(opts.owner_session ? { owner_session: opts.owner_session } : {}),
  });
  const statePath = writeCtoState(state, opts.cwd);
  opts.log?.(`cto: plan ${built.plan.id} — ${built.plan.teams.length} teams, depth ${depth.depth}, state ${statePath}`);
  return { ok: true, plan: built.plan, state, statePath };
}
