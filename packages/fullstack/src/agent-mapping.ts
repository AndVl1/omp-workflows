import {
  AgentMappingWriteError,
  buildAgentMapping,
  PinnedProjectRoot,
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
  "specification-analyst": ["specification-worker"],
  "specification-architect": ["specification-worker"],
  diagnostics: ["diagnostics", "analyst", "tech-researcher"],
  architect: ["architect"],
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

const NATIVE_SPECIFICATION_ROLES = new Set(["specification-analyst", "specification-architect"]);

const refreshes = new Map<string, Promise<AgentMappingState>>();
const freshMappings = new Map<string, AgentMappingState>();
const typedRefreshFailures = new Map<string, AgentMappingWriteError>();
/** Bound historical root identities retained by this extension process. */
export const MAX_FULLSTACK_AGENT_MAPPING_ROOTS = 64;
let mappingGeneration = 0;

function rootIdentityKey(root: PinnedProjectRoot): string {
  return `${root.canonical_root}\u0000${root.dev}:${root.ino}`;
}

function rootChanged(root: PinnedProjectRoot): Error | undefined {
  return root.isStable() ? undefined : new Error("activation_identity_changed: fullstack project root changed");
}

/**
 * Remove entries whose immutable root no longer exists at the recorded path or
 * whose path now resolves to a replacement inode. Persisted mappings remain
 * authoritative; these maps are only in-process freshness/failure state.
 */
function sweepStaleRootCaches(): void {
  const keys = new Set([...freshMappings.keys(), ...typedRefreshFailures.keys()]);
  for (const key of keys) {
    const separator = key.lastIndexOf("\u0000");
    if (separator < 0) {
      freshMappings.delete(key);
      typedRefreshFailures.delete(key);
      continue;
    }
    const canonicalRoot = key.slice(0, separator);
    const root = PinnedProjectRoot.open(canonicalRoot);
    if (!root) {
      freshMappings.delete(key);
      typedRefreshFailures.delete(key);
      continue;
    }
    try {
      if (rootIdentityKey(root) !== key) {
        freshMappings.delete(key);
        typedRefreshFailures.delete(key);
      }
    } finally {
      root.close();
    }
  }
}

function cachedRootCount(): number {
  return new Set([
    ...refreshes.keys(),
    ...freshMappings.keys(),
    ...typedRefreshFailures.keys(),
  ]).size;
}

// OMP's task discovery module imports Bun-only runtime helpers; keep it lazy so
// Node-based package tests can exercise the pure mapping path with an injected
// discovery function.
async function defaultAgentDiscovery(cwd: string): Promise<{ agents: ReadonlyArray<{ name: string }> }> {
  const { discoverAgents } = await import("@oh-my-pi/pi-coding-agent/task");
  return discoverAgents(cwd);
}

/** Discovery seam used by the session hook and deterministic tests. */
export type AgentDiscovery = (cwd: string) => Promise<{ agents: ReadonlyArray<{ name: string }> }>;
/** Activation/context liveness checked immediately before any config read/write. */
export type AgentMappingLiveness = () => boolean;

/** Discover the effective OMP roster and atomically publish its role mapping. */
export function refreshFullstackAgentMappings(cwd: string, discover: AgentDiscovery = defaultAgentDiscovery, isLive?: AgentMappingLiveness): Promise<AgentMappingState> {
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return Promise.reject(new Error("activation_identity_changed: fullstack project root could not be pinned"));
  const sessionCwd = pinnedRoot.canonical_root;
  const refreshKey = rootIdentityKey(pinnedRoot);
  sweepStaleRootCaches();
  if (!refreshes.has(refreshKey)
    && !freshMappings.has(refreshKey)
    && !typedRefreshFailures.has(refreshKey)
    && cachedRootCount() >= MAX_FULLSTACK_AGENT_MAPPING_ROOTS) {
    pinnedRoot.close();
    return Promise.reject(new Error("fullstack agent mapping cache capacity exceeded; close stale sessions before refreshing another root"));
  }
  const refreshGeneration = mappingGeneration;
  const running = refreshes.get(refreshKey);
  if (running) {
    pinnedRoot.close();
    return running;
  }
  let discovered: Promise<{ agents: ReadonlyArray<{ name: string }> }>;
  try {
    discovered = discover(sessionCwd);
  } catch (error) {
    pinnedRoot.close();
    return Promise.reject(error);
  }
  const refresh = discovered
    .then(({ agents }) => {
      const beforeConfigError = rootChanged(pinnedRoot);
      if (beforeConfigError) throw beforeConfigError;
      if (isLive && !isLive()) throw new Error("activation_identity_changed: fullstack activation is no longer live");
      const config = resolveConfig(sessionCwd, {}, pinnedRoot) as RoleConfig & {
        config_path: string | null;
        config_source: string;
        config_hash: string;
        config_version: string | number | null;
        config_provenance: unknown;
      };
      const afterConfigError = rootChanged(pinnedRoot);
      if (afterConfigError) throw afterConfigError;
      const genericFallbackRoles = Array.from(new Set([
        ...Object.keys(defaultFullstackAgentFallbacks).filter(role => role !== "security-tester" && !NATIVE_SPECIFICATION_ROLES.has(role)),
        ...Object.entries(config.roles)
          .filter(([role]) => role !== "security-tester" && !NATIVE_SPECIFICATION_ROLES.has(role))
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
      const beforeWriteError = rootChanged(pinnedRoot);
      if (beforeWriteError) throw beforeWriteError;
      if (isLive && !isLive()) throw new Error("activation_identity_changed: fullstack activation is no longer live");
      if (refreshGeneration !== mappingGeneration) throw new Error("activation_identity_changed: fullstack mapping refresh belongs to a closed session generation");
      writeAgentMapping(sessionCwd, mapping, pinnedRoot);
      if (refreshGeneration !== mappingGeneration) throw new Error("activation_identity_changed: fullstack mapping refresh belongs to a closed session generation");
      freshMappings.set(refreshKey, mapping);
      typedRefreshFailures.delete(refreshKey);
      return mapping;
    })
    .catch((error: unknown) => {
      freshMappings.delete(refreshKey);
      if (error instanceof AgentMappingWriteError) typedRefreshFailures.set(refreshKey, error);
      throw error;
    })
    .finally(() => {
      refreshes.delete(refreshKey);
      pinnedRoot.close();
    });
  refreshes.set(refreshKey, refresh);
  return refresh;
}

/** Drop all in-memory discovery generations; persisted JSON is never a fallback authority. */
export function clearFullstackAgentMappings(cwd?: string): void {
  mappingGeneration += 1;
  if (cwd === undefined) {
    freshMappings.clear();
    typedRefreshFailures.clear();
    return;
  }
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return;
  try {
    const key = rootIdentityKey(pinnedRoot);
    freshMappings.delete(key);
    typedRefreshFailures.delete(key);
  } finally {
    pinnedRoot.close();
  }
}

/**
 * Wait for a session-start refresh when one is in flight. Tests and consumers
 * that do not install the fullstack extension retain static config behavior,
 * but stale mappings are filtered through the same config reader.
 */
export function waitForFullstackAgentMappings(cwd: string): Promise<AgentMappingState | undefined> {
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return Promise.resolve(undefined);
  const sessionCwd = pinnedRoot.canonical_root;
  const refreshKey = rootIdentityKey(pinnedRoot);
  sweepStaleRootCaches();
  const running = refreshes.get(refreshKey);
  if (running) {
    return running
      .catch((error: unknown) => {
        throw error;
      })
      .finally(() => pinnedRoot.close());
  }
  const typedFailure = typedRefreshFailures.get(refreshKey);
  if (typedFailure) {
    pinnedRoot.close();
    return Promise.reject(typedFailure);
  }
  const current = freshMappings.get(refreshKey);
  pinnedRoot.close();
  return Promise.resolve(current);
}
