/**
 * TeamPlan lifecycle: build + validate.
 *
 * The CTO agent (or a consumer's own orchestrator) produces a decomposition;
 * the engine validates it against the hard caps and TeamDef registry before
 * it is persisted and executed. Two-layer contract: the engine never decides
 * the decomposition itself — it guards what the orchestrator proposes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TEAMS, MAX_DECOMPOSITION_DEPTH, type TeamDef, type TeamPlan, type TeamPlanEntry, type WorktreeStrategy } from "./types.js";

export interface PlanTeamInput {
  team: string;
  scope: string[];
  slice: string;
  profile: string;
  worktree?: WorktreeStrategy;
  depends_on?: string[];
}

export interface PlanBuildInput {
  /** CTO run id (slug); matches `.work-state/cto/<id>/`. */
  id: string;
  task: string;
  teams: PlanTeamInput[];
}

export type BuildResult = { ok: true; plan: TeamPlan } | { ok: false; reason: string };

/**
 * TeamDef registry loader: reads the consumer-owned `.omp/teams.json`
 * (array of {@link TeamDef}). Missing/malformed file -> empty array (never
 * throws). Consumers may also pass TeamDef[] directly to the engine.
 */
export function loadTeamDefs(cwd: string): TeamDef[] {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".omp", "teams.json"), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is TeamDef => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as TeamDef).id === "string" &&
        typeof (entry as TeamDef).name === "string"
      );
    });
  } catch {
    return [];
  }
}

/**
 * Build a TeamPlan and validate it. Returns a reason on any violation:
 * caps (MAX_TEAMS), unknown team ids, depends_on cycles or dangling refs.
 */
export function buildTeamPlan(input: PlanBuildInput, defs: Record<string, TeamDef> | Map<string, TeamDef>): BuildResult {
  if (!input || !input.id || !input.task) return { ok: false, reason: "plan needs { id, task }" };
  if (input.id.length > 80 || !/^[a-z0-9][a-z0-9-_]*$/.test(input.id)) {
    return { ok: false, reason: `plan id must be a slug, got: ${input.id}` };
  }
  if (!Array.isArray(input.teams)) return { ok: false, reason: "plan.teams must be an array" };
  if (input.teams.length === 0) return { ok: false, reason: "plan.teams is empty — nothing to orchestrate" };
  if (input.teams.length > MAX_TEAMS) {
    return { ok: false, reason: `plan has ${input.teams.length} teams, cap is ${MAX_TEAMS}` };
  }

  const lookup = (id: string): TeamDef | undefined => (defs instanceof Map ? defs.get(id) : defs[id]);

  const entries: TeamPlanEntry[] = [];
  const seen = new Set<string>();
  for (const t of input.teams) {
    const def = lookup(t.team);
    if (!def) return { ok: false, reason: `unknown team id: ${t.team}` };
    if (seen.has(t.team)) return { ok: false, reason: `duplicate team id in plan: ${t.team}` };
    seen.add(t.team);
    entries.push({
      team: t.team,
      scope: [...(t.scope ?? def.scope)],
      slice: t.slice,
      profile: t.profile ?? def.profile,
      worktree: t.worktree ?? "same_branch",
      depends_on: [...(t.depends_on ?? [])],
    });
  }

  // depends_on: dangling refs + cycles (DFS on the team graph).
  for (const entry of entries) {
    for (const dep of entry.depends_on) {
      if (!seen.has(dep)) return { ok: false, reason: `${entry.team} depends on unknown team: ${dep}` };
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (teamId: string): boolean => {
    if (visiting.has(teamId)) return false; // cycle
    if (visited.has(teamId)) return true;
    visiting.add(teamId);
    const entry = entries.find((e) => e.team === teamId);
    const deps = entry ? entry.depends_on : [];
    for (const dep of deps) {
      if (!visit(dep)) return false;
    }
    visiting.delete(teamId);
    visited.add(teamId);
    return true;
  };
  for (const entry of entries) {
    if (!visit(entry.team)) {
      return { ok: false, reason: `depends_on cycle detected involving: ${entry.team}` };
    }
  }

  return {
    ok: true,
    plan: { id: input.id, task: input.task, teams: entries, created_at: new Date().toISOString() },
  };
}

/**
 * Decomposition depth of a plan: 1 for a flat plan; a team whose sub-profile
 * itself contains `type: team` stages adds a level. The consumer supplies a
 * `profileDepth` loader when it can see sub-profile contents; without one the
 * plan is assumed flat (depth 1). Enforces MAX_DECOMPOSITION_DEPTH (2).
 */
export function validateDecompositionDepth(
  plan: TeamPlan,
  profileDepth?: (profile: string) => number,
): { ok: true; depth: number } | { ok: false; reason: string; depth: number } {
  if (!profileDepth) return { ok: true, depth: 1 };
  let depth = 1;
  for (const entry of plan.teams) {
    depth = Math.max(depth, 1 + profileDepth(entry.profile));
  }
  if (depth > MAX_DECOMPOSITION_DEPTH) {
    return {
      ok: false,
      reason: `decomposition depth ${depth} exceeds cap ${MAX_DECOMPOSITION_DEPTH} (CTO -> team -> sub-team)`,
      depth,
    };
  }
  return { ok: true, depth };
}
