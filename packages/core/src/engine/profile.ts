import { createHash } from "node:crypto";
/**
 * Profile loader and classification resolver.
 *
 * Same model as claude-plugin: same JSON profile format, same selection order,
 * same Type x Complexity -> Workflow table.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProfileExpressions } from "./predicate.js";
import { validateStageFanInResolutions } from "./fan-in.js";
import type { Classification, Complexity, Profile, TaskType, WorkflowName } from "./types.js";

/** Selection order — first match wins. */
const SELECTION_ORDER: WorkflowName[] = [
  "full-feature",
  "debug-cycle",
  "bug-fix",
  "standard",
  "lightweight",
  "research",
  "spec-preparation",
  "feature-regression",
  "review",
  "emergency",
];
const registeredProfiles = new Map<string, Profile>();

/** Register bundle-owned profiles for the core interpreter. */
export function registerWorkflowProfiles(profiles: Profile[]): void {
  for (const profile of profiles) {
    if (!profile.name || !profile.stages?.length || !profile.match?.type) {
      throw new Error(`invalid workflow profile registration: ${JSON.stringify(profile)}`);
    }
    // Reject unsupported DSL at load: an expression that cannot parse must
    // never silently evaluate to false during a run.
    const diagnostics = validateProfileExpressions(profile);
    if (diagnostics.length > 0) {
      throw new Error(`invalid workflow profile '${profile.name}' expressions: ${diagnostics.join("; ")}`);
    }
    // Reject malformed fan-in resolutions at load: a resolution must
    // deliberately document exactly how a required-scalar disagreement is
    // resolved, so it can never resolve a disagreement silently.
    const fanInDiagnostics = profile.stages.flatMap((stage) => validateStageFanInResolutions(stage));
    if (fanInDiagnostics.length > 0) {
      throw new Error(`invalid workflow profile '${profile.name}' fan-in resolutions: ${fanInDiagnostics.join("; ")}`);
    }
    registeredProfiles.set(profile.name, profile);
  }
}
export function isRegisteredWorkflow(name: string): boolean {
  return registeredProfiles.has(name) || loadAllProfiles().some((profile) => profile.name === name);
}

export function matchesProfile(name: string, c: Pick<Classification, "type" | "complexity">): boolean {
  const profile = loadAllProfiles().find((candidate) => candidate.name === name);
  if (!profile) return false;
  return profile.match.type.includes(c.type) && (!profile.match.complexity || profile.match.complexity.includes(c.complexity));
}

export function findProfileDir(): string {
  // Distribution layout: <pkg>/dist/engine/profile.js -> <pkg>/workflows/
  const here = fileURLToPath(import.meta.url);
  const pkgRoot = resolve(here, "..", "..", "..");
  return join(pkgRoot, "workflows");
}

export function loadAllProfiles(): Profile[] {
  const dir = findProfileDir();
  const result = [...registeredProfiles.values()];
  if (existsSync(dir)) {
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
  }
  const unique = new Map(result.map((profile) => [profile.name, profile]));
  return [...unique.values()].sort((a, b) => {
    const ai = SELECTION_ORDER.indexOf(a.name);
    const bi = SELECTION_ORDER.indexOf(b.name);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  });
}
export function resolveWorkflowProfilePath(name: string, _cwd?: string): string | null {
  const path = join(findProfileDir(), `${name}.json`);
  return existsSync(path) ? path : null;
}

export function loadProfile(name: WorkflowName): Profile | null {
  return loadAllProfiles().find((p) => p.name === name) ?? null;
}

/** Stable canonical SHA-256 fingerprint used to reject profile drift. */
export function profileHash(profile: Profile): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(profile))).digest("hex");
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
    case "SPEC":
      return "spec-preparation";
    case "REGRESS":
      return "feature-regression";
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
 *
 * SPEC and REGRESS are dedicated intents: a model-provided workflow such as
 * `standard` must not silently hijack either intent. The explicit
 * `workflow_override: true` state marker is the intentional escape hatch
 * enforced by the P5 gate; profile selection itself remains safe by falling
 * back to the dedicated profile.
 */
export function selectProfile(profiles: Profile[], c: Classification): Profile | null {
  const dedicated = c.type === "SPEC" ? "spec-preparation" : c.type === "REGRESS" ? "feature-regression" : null;
  const explicit = profiles.find((p) => p.name === c.workflow);
  if (explicit && (!dedicated || explicit.name === dedicated)) return explicit;
  for (const name of SELECTION_ORDER) {
    const p = profiles.find((x) => x.name === name);
    if (!p) continue;
    if (!p.match.type.includes(c.type)) continue;
    if (p.match.complexity && !p.match.complexity.includes(c.complexity)) continue;
    return p;
  }
  return null;
}
