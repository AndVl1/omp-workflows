/**
 * Allowed agent pool, workflow role/scope/flag taxonomy and the bundle-owned
 * live agent-mapping refresh for the private OMP bundle. Defined HERE, not
 * imported from fullstack: this bundle is a single-writer fork of the
 * composition surface with a deliberately narrowed pool. Kotlin, Go,
 * frontend, mobile and Rust writer roles are excluded, and the mapping
 * published from host discovery never falls back to them (or to the generic
 * `task` agent) — see the refresh section below.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildAgentMapping,
	resolveConfig,
	writeAgentMapping,
	type AgentMappingState,
	type Profile,
	type RoleConfig,
	type ScopeRuntimeClassTable,
} from "@andvl1/omp-workflows-core";

import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task";

import { detectWorkspaceMarkers } from "./activation.js";
import { OMP_INTERNAL_ACTIVATION_MARKER, OMP_INTERNAL_BUNDLE_ID } from "./identity.js";
import { loadOmpWorkflowProfiles } from "./profiles.js";

/** The complete allowed pool — every agent shipped in agents/. */
export const ALLOWED_POOL_AGENTS: readonly string[] = [
	"omp-team-lead",
	"omp-analyst",
	"omp-tech-researcher",
	"omp-diagnostics",
	"omp-architect",
	"omp-qa",
	// Pool-only (finding F1): no scope trigger references manual-qa in this
	// bundle's profiles — nothing under a TS monorepo can set has_ui. It stays
	// available for orchestrator-initiated validation tasks.
	"omp-manual-qa",
	"omp-code-reviewer",
	"omp-security-tester",
	// Conditional: joined only when scope flags (e.g. has_infra) demand it.
	"omp-devops",
	// Custom specialists for this TypeScript/OMP monorepo domain.
	"omp-plugin-developer",
	"omp-engine-specialist",
	"omp-host-integration-specialist",
	"omp-package-release-specialist",
];

/**
 * Workflow role → agent mapping. Keys are the role names referenced by
 * workflow profiles and gates; values are hyphen-prefixed omp-* agents.
 */
export const defaultOmpInternalRoles: RoleConfig["roles"] = {
	"team-lead": "omp-team-lead",
	analyst: "omp-analyst",
	"tech-researcher": "omp-tech-researcher",
	diagnostics: "omp-diagnostics",
	architect: "omp-architect",
	developer: "omp-engine-specialist",
	qa: "omp-qa",
	"manual-qa": "omp-manual-qa",
	"code-reviewer": "omp-code-reviewer",
	"security-tester": "omp-security-tester",
	devops: "omp-devops",
	"plugin-developer": "omp-plugin-developer",
	"host-integration": "omp-host-integration-specialist",
	"package-release": "omp-package-release-specialist",
};
/**
 * Scope map. Deliberately excludes rust/kotlin/go/frontend/mobile domains:
 * `${scope.dev_agent}` resolution maps onto bundle generalists instead of
 * domain writers that do not exist in this pool.
 */
export const defaultOmpInternalScopeMap: RoleConfig["scope_map"] = [
	{
		glob: ["**/Dockerfile", "**/*.yaml", "**/*.yml", "**/helm/**", "**/.github/workflows/**"],
		scope: "devops",
		dev_agent: "omp-devops",
	},
	{
		// INT-001: core no longer classifies scopes by built-in domain tables,
		// so this bundle supplies its own runtime classes explicitly.
		glob: ["packages/**/*.ts", "*.ts", "*.json"],
		scope: "dev",
		dev_agent: "omp-engine-specialist",
	},
];

/** Bundle-owned classification (INT-001): devops and TS sources are runnable; no UI scopes exist here. */
export const defaultOmpInternalScopeRuntimeClasses: ScopeRuntimeClassTable = {
	devops: "runtime",
	dev: "runtime",
};

export const defaultOmpInternalScopeUiClasses: ScopeRuntimeClassTable = {};

/** Conditional roster triggers reused by profile `conditional` stages. */
export const defaultOmpInternalFlags: RoleConfig["flags"] = {
	has_security: ["**/auth/**", "**/security/**", "**/*crypto*", "**/*Secret*", "**/*Token*"],
	has_infra: ["**/Dockerfile", "**/helm/**", "**/k8s/**", "**/.github/workflows/**"],
};

// ── Bundle-owned live agent-mapping refresh ─────────────────────────────────
//
// The internal bundle refreshes the host agent mapping itself: it lazily
// obtains the host `discoverAgents` inventory, resolves every workflow role
// against the EXACT pool and publishes the result through core
// `buildAgentMapping`. Two security properties hold (W004):
//
// 1. Provenance (INTEGRITY): a discovered definition enters the inventory
//    only when its name is in `ALLOWED_POOL_AGENTS` AND its recorded
//    `filePath` resolves — through symlinks and traversal — to the matching
//    real file under this bundle's own `agents/` directory. Same-name
//    shadows from project/user/other-plugin dirs, path traversal, non-file
//    entries and provenance-free records all fail closed; `omp-attacker`
//    and intentional non-omp roles are excluded by the pool check itself.
// 2. Freshness: begin authorizes from the mapping derived in this session.
//    The provenance-checked result is kept in memory and handed to core via
//    `beforeBegin`; the persisted mapping file is a write-through for
//    non-handoff consumers and is NEVER read back as a begin fallback. A
//    failed refresh propagates and invalidates the in-memory mapping, so a
//    stale or tampered roster can never be accepted at begin. Because
//    discovery is asynchronous, an in-flight refresh re-verifies the marker
//    gate when discovery resolves and again before publishing: markers lost
//    mid-flight reject the refresh (and every joiner) fail-closed and
//    invalidate any prior or fresh cache, so markers restored later force a
//    genuinely fresh discovery instead of resurrecting stale data.
//
// No fullstack dependency and no generic `task`/domain-writer fallback ever
// enters the map: no fallback chains are declared and the generic fallback
// is disabled outright (`genericFallbackRoles: []`), so a role whose pool
// agent is absent is recorded `unavailable` and core blocks any begin whose
// selection needs it.

/**
 * Directory holding this bundle's own agent definitions. Resolved from this
 * module's location (`src/` or `dist/` both sit one level under the package
 * root), so provenance checks are anchored to the shipping bundle itself.
 */
const BUNDLE_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");

/**
 * Provenance-bearing subset of the host `AgentDefinition` that discovery
 * must retain through the seam: the agent name, its host source and the
 * file that defines it.
 */
export interface InternalDiscoveredAgent {
	name: string;
	source: AgentDefinition["source"];
	/** Absolute path of the defining file; file-backed agents only. */
	filePath?: string;
}

/**
 * Discovery seam for deterministic tests: resolves the host agent inventory
 * for a project root, carrying each definition's provenance. Production
 * resolves lazily via the host `task` module, which pulls Bun-only runtime
 * helpers and must never be imported statically.
 */
export type InternalAgentDiscovery = (cwd: string) => Promise<{ agents: ReadonlyArray<InternalDiscoveredAgent> }>;

/** In-flight refreshes keyed by resolved session root (dedup per cwd). */
const mappingRefreshes = new Map<string, Promise<AgentMappingState>>();

/**
 * Last discovery-verified mapping per resolved session root. The only
 * runtime source `beforeBegin` trusts: the persisted mapping file is a
 * write-through for non-handoff consumers and is never read back here.
 */
const freshMappings = new Map<string, AgentMappingState>();

/**
 * Marker re-check for the asynchronous refresh path (W004-MAPPING-FRESHNESS):
 * discovery is an async suspension window in which the workspace can lose its
 * markers. The full marker set must still stand when discovery resolves and
 * again when the mapping is about to be published; anything shorter fails
 * closed. The typed error matches the kickoff gate so every seam rejects
 * identically.
 */
function assertMarkersCurrent(sessionCwd: string): void {
	if (!detectWorkspaceMarkers(sessionCwd).ok) {
		throw new Error(`activation_markers_missing: ${OMP_INTERNAL_ACTIVATION_MARKER}`);
	}
}

async function defaultAgentDiscovery(cwd: string): Promise<{ agents: ReadonlyArray<InternalDiscoveredAgent> }> {
	const { discoverAgents } = await import("@oh-my-pi/pi-coding-agent/task");
	const { agents } = await discoverAgents(cwd);
	return { agents: agents.map(({ name, source, filePath }) => ({ name, source, filePath })) };
}

/**
 * The real file inside this bundle's own agents directory that must define
 * `name`. Undefined — including any fs error — means the name has no
 * bundle-owned definition file and can never enter the inventory.
 */
function bundleAgentFile(name: string): string | undefined {
	if (!ALLOWED_POOL_AGENTS.includes(name)) return undefined;
	try {
		const real = realpathSync(join(BUNDLE_AGENTS_DIR, `${name}.md`));
		return statSync(real).isFile() ? real : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Provenance filter: an agent enters the inventory only when its name is in
 * the pool AND its recorded definition file resolves — through symlinks and
 * traversal — to the matching real file under this bundle's own agents
 * directory. Everything else fails closed.
 */
function bundleOwnedInventory(agents: ReadonlyArray<InternalDiscoveredAgent>): string[] {
	const inventory = new Set<string>();
	for (const agent of agents) {
		const expected = bundleAgentFile(agent.name);
		if (!expected || !agent.filePath) continue;
		try {
			if (realpathSync(agent.filePath) !== expected) continue;
		} catch {
			continue;
		}
		inventory.add(agent.name);
	}
	return [...inventory];
}

/**
 * Roles the shipped profiles always dispatch: stage `role`/`roles` minus
 * roles reachable only via `conditional` adds (security-tester, devops) and
 * minus dynamically selected roster roles, which core blocks at begin when
 * their agent is unmapped. Only these required roles fail the refresh closed;
 * every other pool entry may be absent and is recorded `unavailable`.
 */
export function requiredInternalProfileRoles(profiles: readonly Profile[]): string[] {
	const required = new Set<string>();
	const conditional = new Set<string>();
	for (const profile of profiles) {
		for (const stage of profile.stages) {
			for (const entry of stage.conditional ?? []) {
				if (entry.add) conditional.add(entry.add);
			}
			if (stage.role) required.add(stage.role);
			for (const role of stage.roles ?? []) required.add(role);
		}
	}
	for (const role of conditional) required.delete(role);
	return [...required];
}

/**
 * Discover the live host roster and atomically publish the bundle's role
 * mapping. Marker-gated (fails closed outside the marked workspace), deduped
 * per resolved root, provenance-enforced (only pool agents whose definition
 * file resolves inside this bundle's own agents directory are candidates),
 * and fail-closed when an agent required by the active profiles is missing
 * from host discovery. Config roles and provenance are taken verbatim from
 * `resolveConfig` so core accepts the generated mapping. Because discovery
 * is asynchronous, the marker gate is re-verified twice inside the refresh:
 * when discovery resolves and again immediately before the mapping is
 * written, cached or returned — markers lost mid-flight reject fail-closed
 * and invalidate the cache (W004-MAPPING-FRESHNESS). On success the mapping
 * is cached in memory as the begin-time authority and written through to
 * the core mapping path; on failure the cached mapping is invalidated and
 * the error propagates.
 */
export function refreshInternalAgentMappings(
	cwd: string,
	discover: InternalAgentDiscovery = defaultAgentDiscovery,
): Promise<AgentMappingState> {
	const resolvedCwd = resolve(cwd);
	const sessionCwd = existsSync(resolvedCwd) ? realpathSync(resolvedCwd) : resolvedCwd;
	const running = mappingRefreshes.get(sessionCwd);
	if (running) return running;
	if (!detectWorkspaceMarkers(sessionCwd).ok) {
		// Markers removed mid-session: the workspace is no longer ours to
		// serve — drop any cached runtime mapping with it.
		freshMappings.delete(sessionCwd);
		return Promise.reject(new Error(`activation_markers_missing: ${OMP_INTERNAL_ACTIVATION_MARKER}`));
	}
	const refresh = discover(sessionCwd)
		.then(({ agents }) => {
			// Discovery just resolved after an async suspension: the workspace
			// may have lost its markers while it was in flight.
			assertMarkersCurrent(sessionCwd);
			const inventory = bundleOwnedInventory(agents);
			const config = resolveConfig(sessionCwd);
			const requiredAgents = [
				...new Set(
					requiredInternalProfileRoles(loadOmpWorkflowProfiles()).map(
						(role) => config.roles[role] ?? role,
					),
				),
			];
			const missing = requiredAgents.filter((name) => !inventory.includes(name));
			if (missing.length > 0) {
				throw new Error(`required omp agents missing from host discovery: ${missing.join(", ")}`);
			}
			const mapping = buildAgentMapping({
				roles: config.roles,
				availableAgents: inventory,
				extraRoles: config.scope_map.map((entry) => entry.dev_agent),
				genericFallback: null,
				genericFallbackRoles: [],
				source: OMP_INTERNAL_BUNDLE_ID,
				scope_map: config.scope_map,
				flags: config.flags,
				roster: config.roster_overrides,
				config_path: config.config_path,
				config_source: config.config_source,
				config_hash: config.config_hash,
				config_version: config.config_version,
				config_provenance: config.config_provenance,
			});
			// Publish-time re-check: nothing is written, cached or returned
			// once activation is gone, however briefly discovery raced it.
			assertMarkersCurrent(sessionCwd);
			writeAgentMapping(sessionCwd, mapping);
			freshMappings.set(sessionCwd, mapping);
			return mapping;
		})
		.catch((error: unknown) => {
			// A failed discovery invalidates the runtime mapping: the roster was
			// just re-derived and could not be reproduced, so serving the last
			// accepted one would authorize begin from a stale roster. The next
			// begin re-attempts discovery or fails closed — it never falls back
			// to the persisted mapping file.
			freshMappings.delete(sessionCwd);
			throw error;
		})
		.finally(() => {
			mappingRefreshes.delete(sessionCwd);
		});
	mappingRefreshes.set(sessionCwd, refresh);
	return refresh;
}

/**
 * Ensure a fresh, discovery-verified mapping for `workflow_begin` (the
 * workflow tool adapter calls this in `beforeBegin`, before
 * `workflow_begin`, and its resolved value is handed to core as the trusted
 * mapping for this begin). Re-checks the CURRENT workspace markers on every
 * call — before joining an in-flight refresh or serving the cached mapping —
 * so a direct workflow tool call after marker removal retains no authority:
 * the runtime cache is invalidated and the typed
 * `activation_markers_missing` rejection blocks the transition. With markers
 * present it joins an in-flight refresh, otherwise serves the last
 * discovery-verified mapping from memory, otherwise kicks a new refresh —
 * and rejects whenever discovery fails, so begin is blocked fail-closed
 * instead of being authorized from the persisted (possibly stale or
 * tampered) mapping file, which is never read back here. A joiner that
 * passed its own entry check still inherits the fail-closed rejection when
 * markers vanish while the joined refresh is in flight: the refresh
 * re-verifies markers at discovery completion and before publish.
 */
export function waitForInternalAgentMappings(
	cwd: string,
	discover: InternalAgentDiscovery = defaultAgentDiscovery,
): Promise<AgentMappingState> {
	const resolvedCwd = resolve(cwd);
	const sessionCwd = existsSync(resolvedCwd) ? realpathSync(resolvedCwd) : resolvedCwd;
	if (!detectWorkspaceMarkers(sessionCwd).ok) {
		freshMappings.delete(sessionCwd);
		return Promise.reject(new Error(`activation_markers_missing: ${OMP_INTERNAL_ACTIVATION_MARKER}`));
	}
	const running = mappingRefreshes.get(sessionCwd);
	if (running) return running;
	const fresh = freshMappings.get(sessionCwd);
	if (fresh) return Promise.resolve(fresh);
	return refreshInternalAgentMappings(sessionCwd, discover);
}
