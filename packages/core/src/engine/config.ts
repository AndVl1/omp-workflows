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
  mappingPreferencesHash,
  readAgentMapping,
  type AgentMappingDiagnostic,
} from "./agent-mapping.js";
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
  const roles = { ...DEFAULT_ROLES, ...(override.roles ?? {}) };
  const scope_map = override.scope_map && override.scope_map.length > 0 ? override.scope_map : DEFAULT_SCOPE_MAP;
  const generated = readAgentMapping(cwd);
  const extraRoles = scope_map.map(entry => entry.dev_agent);
  const agent_mapping = generated
    && generated.preferences_hash === mappingPreferencesHash(roles, extraRoles)
    ? generated
    : undefined;
  return {
    roles,
    roster_overrides: { ...(override.roster_overrides ?? {}) },
    scope_map,
    flags: { ...DEFAULT_FLAGS, ...(override.flags ?? {}) },
    design_system: override.design_system ?? null,
    agent_mapping,
  };
}

export function resolveAgentForRole(role: string, config: RoleConfig): string {
  return config.agent_mapping?.resolved_roles[role] ?? config.roles[role] ?? role;
}

/** Return a truthful diagnostic when discovery could not resolve a role. */
export function agentMappingIssueForRole(role: string, config: RoleConfig): AgentMappingDiagnostic | undefined {
  const diagnostic = config.agent_mapping?.diagnostics[role];
  return diagnostic?.status === "unavailable" ? diagnostic : undefined;
}
