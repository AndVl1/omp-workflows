/**
 * Profile loader and classification resolver.
 *
 * Same model as claude-plugin: same JSON profile format, same selection order,
 * same Type x Complexity -> Workflow table.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Classification, Complexity, Profile, TaskType, WorkflowName } from "./types.js";

/** Selection order — first match wins. */
const SELECTION_ORDER: WorkflowName[] = [
  "full-feature",
  "debug-cycle",
  "bug-fix",
  "standard",
  "lightweight",
  "research",
  "review",
  "emergency",
];

export function findProfileDir(): string {
  // Distribution layout: <pkg>/dist/engine/profile.js -> <pkg>/workflows/
  const here = fileURLToPath(import.meta.url);
  const pkgRoot = resolve(here, "..", "..", "..");
  return join(pkgRoot, "workflows");
}

export function loadAllProfiles(): Profile[] {
  const dir = findProfileDir();
  if (!existsSync(dir)) return [];
  const result: Profile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    if (name.startsWith("_") || name === "artifacts-schema.json" || name === "team.config.example.json" || name === "team.config.schema.json") continue;
    const path = join(dir, name);
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Profile;
      if (raw?.name && raw?.stages && raw?.match) result.push(raw);
    } catch {
      // skip malformed profile
    }
  }
  // Keep selection order stable.
  result.sort((a, b) => SELECTION_ORDER.indexOf(a.name) - SELECTION_ORDER.indexOf(b.name));
  return result;
}

export function loadProfile(name: WorkflowName): Profile | null {
  return loadAllProfiles().find((p) => p.name === name) ?? null;
}

/**
 * Resolve a workflow from classification. Mirrors the table in
 * workflows/README.md and the bash `expected_workflow` function in
 * claude-plugin's validate-state.sh.
 *
 * Autonomous mode forces BUG_FIX -> debug-cycle (per docs).
 */
export function resolveWorkflow(
  type: TaskType,
  complexity: Complexity,
  autonomous: boolean,
): WorkflowName {
  switch (type) {
    case "FEATURE":
    case "REFACTOR":
      if (complexity === "QUICK") return "lightweight";
      if (complexity === "MEDIUM") return "standard";
      return "full-feature"; // COMPLEX | CRITICAL
    case "OPS":
      if (complexity === "QUICK") return "lightweight";
      return "standard";
    case "BUG_FIX":
      if (autonomous) return "debug-cycle";
      if (complexity === "QUICK") return "bug-fix";
      return "debug-cycle"; // MEDIUM | COMPLEX | CRITICAL
    case "INVESTIGATION":
      return "research";
    case "REVIEW":
      return "review";
    case "HOTFIX":
      return "emergency";
    default:
      return "standard";
  }
}

/**
 * Pick the first profile (in selection order) whose match passes for the
 * classification. Returns null if no profile matches.
 */
export function selectProfile(profiles: Profile[], c: Classification): Profile | null {
  for (const name of SELECTION_ORDER) {
    const p = profiles.find((x) => x.name === name);
    if (!p) continue;
    if (!p.match.type.includes(c.type)) continue;
    if (p.match.complexity && !p.match.complexity.includes(c.complexity)) continue;
    return p;
  }
  return null;
}
