/**
 * Runtime config writer. Persists `RegisterOptions` overrides into
 * `.omp/team.config.json` so the engine resolves roles/models/scope
 * consistently across calls. Used by `registerTeamWorkflow` when the
 * bundle supplies any override.
 *
 * The file is only written if at least one override is supplied.
 * Existing fields are preserved (only the override keys are written).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RoleConfig } from "./engine/types.js";

export function resolveRuntimeConfigPath(cwd: string): string | null {
  const dir = resolve(cwd, ".omp");
  if (!existsSync(dir)) return null;
  return join(dir, "team.config.json");
}

export function writeConfig(path: string, partial: Partial<RoleConfig>): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  let existing: Partial<RoleConfig> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Partial<RoleConfig>;
    } catch {
      existing = {};
    }
  }
  const merged: RoleConfig = {
    roles: { ...(existing.roles ?? {}), ...(partial.roles ?? {}) },
    models: { ...(existing.models ?? {}), ...(partial.models ?? {}) },
    roster_overrides: { ...(existing.roster_overrides ?? {}), ...(partial.roster_overrides ?? {}) },
    scope_map: partial.scope_map && partial.scope_map.length > 0 ? partial.scope_map : (existing.scope_map ?? []),
    flags: { ...(existing.flags ?? {}), ...(partial.flags ?? {}) },
    design_system: partial.design_system ?? existing.design_system ?? null,
  };
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
