import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildAgentMapping,
  resolveConfig,
  writeAgentMapping,
  type AgentMappingState,
  type RoleConfig,
} from "@andvl1/omp-workflows-core";

/**
 * Ordered semantic fallbacks. The generic `task` agent is appended by the
 * core resolver only for roles listed in genericFallbackRoles below.
 */
export const defaultFullstackAgentFallbacks: Record<string, readonly string[]> = {
  analyst: ["analyst", "discovery", "diagnostics", "tech-researcher"],
  "tech-researcher": ["tech-researcher", "discovery", "analyst"],
  diagnostics: ["diagnostics", "analyst", "tech-researcher"],
  architect: ["architect"],
  architect_minimal: ["architect"],
  architect_clean: ["architect"],
  architect_pragmatic: ["architect"],
  "backend-kotlin": ["developer-kotlin"],
  go: ["developer-go"],
  frontend: ["frontend-developer"],
  mobile: ["developer-mobile", "init-mobile"],
  android: ["developer-mobile", "init-mobile"],
  qa: ["qa", "code-reviewer", "diagnostics"],
  "manual-qa": ["manual-qa", "qa", "diagnostics"],
  "code-reviewer": ["code-reviewer", "qa", "architect"],
  "security-tester": ["security-tester"],
  devops: ["devops", "diagnostics"],
  "regression-planner": ["analyst", "diagnostics", "tech-researcher"],
  "regression-executor": ["manual-qa", "qa", "diagnostics"],
  "regression-oracle": ["qa", "code-reviewer", "analyst"],
};

const refreshes = new Map<string, Promise<AgentMappingState>>();

// OMP's task discovery module imports Bun-only runtime helpers; keep it lazy so
// Node-based package tests can exercise the pure mapping path with an injected
// discovery function.
async function defaultAgentDiscovery(cwd: string): Promise<{ agents: ReadonlyArray<{ name: string }> }> {
  const { discoverAgents } = await import("@oh-my-pi/pi-coding-agent/task");
  return discoverAgents(cwd);
}

/** Discovery seam used by the session hook and deterministic tests. */
export type AgentDiscovery = (cwd: string) => Promise<{ agents: ReadonlyArray<{ name: string }> }>;

/** Discover the effective OMP roster and atomically publish its role mapping. */
export function refreshFullstackAgentMappings(cwd: string, discover: AgentDiscovery = defaultAgentDiscovery): Promise<AgentMappingState> {
  const resolvedCwd = resolve(cwd);
  const sessionCwd = existsSync(resolvedCwd) ? realpathSync(resolvedCwd) : resolvedCwd;
  const running = refreshes.get(sessionCwd);
  if (running) return running;
  const refresh = discover(sessionCwd)
    .then(({ agents }) => {
      const config = resolveConfig(sessionCwd) as RoleConfig & {
        config_path: string | null;
        config_source: string;
        config_hash: string;
        config_version: string | number | null;
        config_provenance: unknown;
      };
      const genericFallbackRoles = Array.from(new Set([
        ...Object.keys(defaultFullstackAgentFallbacks).filter(role => role !== "security-tester"),
        ...Object.entries(config.roles)
          .filter(([role]) => role !== "security-tester")
          .map(([, agent]) => agent),
      ]));
      const mappingOptions = {
        roles: config.roles,
        fallbackChains: defaultFullstackAgentFallbacks,
        availableAgents: agents.map(agent => agent.name),
        extraRoles: config.scope_map.map(entry => entry.dev_agent),
        genericFallbackRoles,
        source: "fullstack",
        scope_map: config.scope_map,
        flags: config.flags,
        roster: config.roster_overrides,
        config_path: config.config_path,
        config_source: config.config_source,
        config_hash: config.config_hash,
        config_version: config.config_version,
        config_provenance: config.config_provenance,
      } as Parameters<typeof buildAgentMapping>[0];
      const mapping = buildAgentMapping(mappingOptions);
      writeAgentMapping(sessionCwd, mapping);
      return mapping;
    })
    .finally(() => {
      refreshes.delete(sessionCwd);
    });
  refreshes.set(sessionCwd, refresh);
  return refresh;
}

/**
 * Wait for a session-start refresh when one is in flight. Tests and consumers
 * that do not install the fullstack extension retain static config behavior,
 * but stale mappings are filtered through the same config reader.
 */
export function waitForFullstackAgentMappings(cwd: string): Promise<AgentMappingState | undefined> {
  const resolvedCwd = resolve(cwd);
  const sessionCwd = existsSync(resolvedCwd) ? realpathSync(resolvedCwd) : resolvedCwd;
  const readCurrent = (): AgentMappingState | undefined => resolveConfig(sessionCwd).agent_mapping;
  return refreshes.get(sessionCwd)?.catch(() => readCurrent()) ?? Promise.resolve(readCurrent());
}
