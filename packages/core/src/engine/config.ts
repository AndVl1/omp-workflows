/**
 * Resolve `.omp/team.config.json` (or legacy `.claude/team.config.json`) and
 * merge with built-in defaults. The project file overrides built-in defaults.
 *
 * Path resolution order:
 *   1. <cwd>/.omp/team.config.json
 *   2. <cwd>/.claude/team.config.json
 *   3. built-in defaults
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FLAGS,
  DEFAULT_ROLES,
  DEFAULT_SCOPE_MAP,
  type RoleConfig,
} from "./types.js";

export function resolveConfig(cwd: string): RoleConfig {
  const candidates = [
    join(cwd, ".omp", "team.config.json"),
    join(cwd, ".claude", "team.config.json"),
  ];
  let override: Partial<RoleConfig> = {};
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        override = JSON.parse(readFileSync(path, "utf8")) as Partial<RoleConfig>;
      } catch {
        // ignore
      }
      break;
    }
  }
  return {
    roles: { ...DEFAULT_ROLES, ...(override.roles ?? {}) },
    roster_overrides: { ...(override.roster_overrides ?? {}) },
    scope_map: override.scope_map && override.scope_map.length > 0 ? override.scope_map : DEFAULT_SCOPE_MAP,
    flags: { ...DEFAULT_FLAGS, ...(override.flags ?? {}) },
    design_system: override.design_system ?? null,
  };
}

export function resolveAgentForRole(role: string, config: RoleConfig): string {
  return config.roles[role] ?? role;
}
