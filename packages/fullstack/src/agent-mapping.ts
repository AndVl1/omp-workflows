import {
  buildAgentMapping,
  defaultFullstackRoles,
  readAgentMapping,
  resolveConfig,
  writeAgentMapping,
  type AgentMappingState,
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

/** Security review must not silently degrade to a generic worker. */
const genericFallbackRoles = Array.from(new Set([
  ...Object.keys(defaultFullstackAgentFallbacks),
  ...Object.entries(defaultFullstackRoles)
    .filter(([role]) => role !== "security-tester")
    .map(([, agent]) => agent),
]));

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
  const running = refreshes.get(cwd);
  if (running) return running;
  const refresh = discover(cwd)
    .then(({ agents }) => {
      const config = resolveConfig(cwd);
      const mapping = buildAgentMapping({
        roles: config.roles,
        fallbackChains: defaultFullstackAgentFallbacks,
        availableAgents: agents.map(agent => agent.name),
        extraRoles: config.scope_map.map(entry => entry.dev_agent),
        genericFallbackRoles,
      });
      writeAgentMapping(cwd, mapping);
      return mapping;
    })
    .finally(() => {
      refreshes.delete(cwd);
    });
  refreshes.set(cwd, refresh);
  return refresh;
}

/**
 * Wait for a session-start refresh when one is in flight. Tests and consumers
 * that do not install the fullstack extension retain static config behavior.
 */
export function waitForFullstackAgentMappings(cwd: string): Promise<AgentMappingState | undefined> {
  return refreshes.get(cwd)?.catch(() => readAgentMapping(cwd)) ?? Promise.resolve(readAgentMapping(cwd));
}
