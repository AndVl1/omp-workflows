/**
 * Allowed agent pool, workflow role/scope/flag taxonomy and the bundle-owned
 * live agent-mapping refresh for the private OMP bundle. Defined HERE, not
 * imported from fullstack: this bundle is a single-writer fork of the
 * composition surface with a deliberately narrowed pool. Kotlin, Go,
 * frontend, mobile and Rust writer roles are excluded, and the mapping
 * published from host discovery never falls back to them (or to the generic
 * `task` agent) — see the refresh section below.
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildAgentMapping,
	resolveConfig,
	writeAgentMapping,
	PinnedProjectRoot,
	type AgentMappingState,
	type Profile,
	type RoleConfig,
	type ScopeRuntimeClassTable,
} from "@andvl1/omp-workflows-core";

import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task";

import {
	captureWorkspaceActivation,
	validateWorkspaceActivation,
	type WorkspaceActivationSnapshot,
} from "./activation.js";
import { OMP_INTERNAL_ACTIVATION_MARKER, OMP_INTERNAL_BUNDLE_ID } from "./identity.js";
import { loadOmpWorkflowProfiles } from "./profiles.js";

/** The complete allowed pool — every agent shipped in agents/. */
export const ALLOWED_POOL_AGENTS: readonly string[] = [
	"omp-team-lead",
	"omp-analyst",
	"omp-tech-researcher",
	"omp-diagnostics",
	"omp-architect",
	"omp-specification-worker",
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
	"specification-analyst": "omp-specification-worker",
	"specification-architect": "omp-specification-worker",
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
 * Refreshes retain the activation snapshot captured by the entry seam. The
 * snapshot key includes the physical root identity, so a replacement at the
 * same pathname cannot join or invalidate the wrong generation's cache.
 */
function activationKey(snapshot: WorkspaceActivationSnapshot): string {
	return `${snapshot.canonicalRoot}\u0000${snapshot.rootDev}:${snapshot.rootIno}`;
}

function invalidateRootCaches(cwd: string): void {
	const lexical = resolve(cwd);
	const canonical = (() => {
		try { return realpathSync(lexical); } catch { return lexical; }
	})();
	const prefix = `${canonical}\u0000`;
	for (const key of freshMappings.keys()) {
		if (key.startsWith(prefix)) freshMappings.delete(key);
	}
}

function isWorkspaceActivationSnapshot(value: WorkspaceActivationSnapshot | InternalAgentDiscovery | undefined): value is WorkspaceActivationSnapshot {
	return value !== undefined && value !== null && typeof value === "object" && "canonicalRoot" in value && "rootDev" in value && "rootIno" in value && "markers" in value;
}

function snapshotError(snapshot: WorkspaceActivationSnapshot, cwd: string): Error | undefined {
	const checked = validateWorkspaceActivation(snapshot, cwd);
	if (checked.ok) return undefined;
	return new Error(`${checked.code}: ${checked.code === "activation_markers_missing" ? OMP_INTERNAL_ACTIVATION_MARKER : "accepted workspace root or marker identity changed"}`);
}

function openPinnedSnapshot(snapshot: WorkspaceActivationSnapshot): PinnedProjectRoot | undefined {
	const pinned = PinnedProjectRoot.open(snapshot.canonicalRoot);
	if (!pinned) return undefined;
	if (pinned.canonical_root !== snapshot.canonicalRoot
		|| pinned.dev !== snapshot.rootDev
		|| pinned.ino !== snapshot.rootIno
		|| !pinned.isStable()) {
		pinned.close();
		return undefined;
	}
	return pinned;
}

function pinnedSnapshotError(
	snapshot: WorkspaceActivationSnapshot,
	cwd: string,
	pinned: PinnedProjectRoot,
): Error | undefined {
	const current = snapshotError(snapshot, cwd);
	if (current) return current;
	if (!pinned.isStable()
		|| pinned.canonical_root !== snapshot.canonicalRoot
		|| pinned.dev !== snapshot.rootDev
		|| pinned.ino !== snapshot.rootIno) {
		return new Error("activation_identity_changed: retained project root descriptor changed");
	}
	return undefined;
}

function capturedSnapshot(cwd: string): WorkspaceActivationSnapshot {
	const result = captureWorkspaceActivation(cwd);
	if (!result.ok) {
		throw new Error(`${result.code}: ${result.code === "activation_markers_missing" ? OMP_INTERNAL_ACTIVATION_MARKER : "workspace root or marker identity could not be pinned"}`);
	}
	return result.snapshot;
}

function refreshInputs(
	cwd: string,
	snapshotOrDiscover: WorkspaceActivationSnapshot | InternalAgentDiscovery | undefined,
	discover: InternalAgentDiscovery | undefined,
): { snapshot: WorkspaceActivationSnapshot; discover: InternalAgentDiscovery } {
	if (isWorkspaceActivationSnapshot(snapshotOrDiscover)) {
		return { snapshot: snapshotOrDiscover, discover: discover ?? defaultAgentDiscovery };
	}
	if (typeof snapshotOrDiscover === "function") {
		return { snapshot: capturedSnapshot(cwd), discover: snapshotOrDiscover };
	}
	return { snapshot: capturedSnapshot(cwd), discover: discover ?? defaultAgentDiscovery };
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
/**
 * Discover the live host roster while retaining the activation root snapshot.
 * The overload without a snapshot is kept for direct callers/tests; the
 * production activation path always supplies its retained snapshot.
 */
export function refreshInternalAgentMappings(
	cwd: string,
	snapshot: WorkspaceActivationSnapshot,
	discover?: InternalAgentDiscovery,
): Promise<AgentMappingState>;
export function refreshInternalAgentMappings(
	cwd: string,
	discover?: InternalAgentDiscovery,
): Promise<AgentMappingState>;
export function refreshInternalAgentMappings(
	cwd: string,
	snapshotOrDiscover?: WorkspaceActivationSnapshot | InternalAgentDiscovery,
	discover?: InternalAgentDiscovery,
): Promise<AgentMappingState> {
	let inputs: { snapshot: WorkspaceActivationSnapshot; discover: InternalAgentDiscovery };
	try {
		inputs = refreshInputs(cwd, snapshotOrDiscover, discover);
	} catch (error) {
		invalidateRootCaches(cwd);
		return Promise.reject(error);
	}
	const { snapshot, discover: discovery } = inputs;
	const cacheKey = activationKey(snapshot);
	const initialError = snapshotError(snapshot, cwd);
	if (initialError) {
		freshMappings.delete(cacheKey);
		return Promise.reject(initialError);
	}
	const running = mappingRefreshes.get(cacheKey);
	if (running) return running;
	const sessionCwd = snapshot.canonicalRoot;
	const pinnedRoot = openPinnedSnapshot(snapshot);
	if (!pinnedRoot) {
		freshMappings.delete(cacheKey);
		return Promise.reject(new Error("activation_identity_changed: project root could not be pinned"));
	}
	let discovered: Promise<{ agents: ReadonlyArray<InternalDiscoveredAgent> }>;
	try {
		discovered = discovery(sessionCwd);
	} catch (error) {
		discovered = Promise.reject(error);
	}
	const refresh = discovered
		.then(({ agents }) => {
			// Discovery is an async suspension: the retained root and every
			// accepted marker must still identify this activation generation.
			const afterDiscoveryError = pinnedSnapshotError(snapshot, cwd, pinnedRoot);
			if (afterDiscoveryError) throw afterDiscoveryError;
			const inventory = bundleOwnedInventory(agents);
			const config = resolveConfig(sessionCwd, {}, pinnedRoot);
			const afterConfigError = pinnedSnapshotError(snapshot, cwd, pinnedRoot);
			if (afterConfigError) throw afterConfigError;
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
			// This check is immediately adjacent to the writer: no cache or
			// persisted mapping may be produced for a replacement root.
			const beforeWriteError = pinnedSnapshotError(snapshot, cwd, pinnedRoot);
			if (beforeWriteError) throw beforeWriteError;
			writeAgentMapping(sessionCwd, mapping, pinnedRoot);
			freshMappings.set(cacheKey, mapping);
			return mapping;
		})
		.catch((error: unknown) => {
			// Any failed generation, including root replacement, invalidates the
			// retained generation's in-memory authority. A new root identity gets
			// a different key and must perform a fresh discovery.
			freshMappings.delete(cacheKey);
			throw error;
		})
		.finally(() => {
			mappingRefreshes.delete(cacheKey);
			pinnedRoot.close();
		});
	mappingRefreshes.set(cacheKey, refresh);
	return refresh;
}

/**
 * Ensure a fresh, discovery-verified mapping for `workflow_begin`. The
 * retained activation snapshot is checked before joining or serving a cache,
 * then the refresh checks it after async discovery and immediately before
 * writing. A root replacement at the same path therefore cannot inherit the
 * old mapping generation.
 */
export function waitForInternalAgentMappings(
	cwd: string,
	snapshot: WorkspaceActivationSnapshot,
	discover?: InternalAgentDiscovery,
): Promise<AgentMappingState>;
export function waitForInternalAgentMappings(
	cwd: string,
	discover?: InternalAgentDiscovery,
): Promise<AgentMappingState>;
export function waitForInternalAgentMappings(
	cwd: string,
	snapshotOrDiscover?: WorkspaceActivationSnapshot | InternalAgentDiscovery,
	discover?: InternalAgentDiscovery,
): Promise<AgentMappingState> {
	let inputs: { snapshot: WorkspaceActivationSnapshot; discover: InternalAgentDiscovery };
	try {
		inputs = refreshInputs(cwd, snapshotOrDiscover, discover);
	} catch (error) {
		invalidateRootCaches(cwd);
		return Promise.reject(error);
	}
	const { snapshot, discover: discovery } = inputs;
	const cacheKey = activationKey(snapshot);
	const initialError = snapshotError(snapshot, cwd);
	if (initialError) {
		freshMappings.delete(cacheKey);
		return Promise.reject(initialError);
	}
	const running = mappingRefreshes.get(cacheKey);
	if (running) return running;
	const fresh = freshMappings.get(cacheKey);
	if (fresh) return Promise.resolve(fresh);
	return refreshInternalAgentMappings(cwd, snapshot, discovery);
}
