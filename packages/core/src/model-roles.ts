/**
 * Pure model-role taxonomy shared across bundles.
 *
 * This module is the build-time source of truth for the default
 * fullstack class-role/frontmatter mapping plus the stateless helpers
 * (`resolveRoleChain`, `isResearchRequest`, `isResearchResponse`) that
 * any bundle can compose against its own inventory.
 *
 * Intentionally bundle-agnostic: the OMP harness knowledge
 * (`BUILTIN_ROLES`) lives next to consumers that need it (e.g.
 * `packages/fullstack/commands/omp-model-roles/index.ts`), not here.
 *
 * Bundles that ship their own taxonomy (Rust, Go-only, etc.) import the
 * types below and define their own `const MY_MODEL_ROLES: ModelRoleEntry[] = [...]`.
 * They get `resolveRoleChain` + the request/response validators for free.
 */

export interface ModelRoleEntry {
	role: string;
	agents: string[];
	standardFallback: string;
}

/** Single source of truth for the model-class role/frontmatter mapping. */
export const defaultFullstackModelRoles: ModelRoleEntry[] = [
	{ role: "architect", agents: ["architect"], standardFallback: "@slow" },
	{ role: "reviewer", agents: ["code-reviewer"], standardFallback: "@slow" },
	{ role: "security", agents: ["security-tester"], standardFallback: "@slow" },
	{ role: "researcher", agents: ["tech-researcher", "discovery"], standardFallback: "@smol" },
	{ role: "analyst", agents: ["analyst"], standardFallback: "@task" },
	{ role: "developer-go", agents: ["developer-go"], standardFallback: "@task" },
	{ role: "developer-kotlin", agents: ["developer-kotlin"], standardFallback: "@task" },
	{ role: "frontend-developer", agents: ["frontend-developer"], standardFallback: "@task" },
	{ role: "developer-mobile", agents: ["developer-mobile", "init-mobile"], standardFallback: "@task" },
	{ role: "devops", agents: ["devops"], standardFallback: "@task" },
	{ role: "diagnostics", agents: ["diagnostics"], standardFallback: "@task" },
	{ role: "qa", agents: ["qa"], standardFallback: "@task" },
	{ role: "manual-qa", agents: ["manual-qa"], standardFallback: "@task" },
];

export interface InventoryModel {
	selector: string;
	provider: string;
	id: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
}

export interface RoleLookup {
	getModelRole(role: string): string | undefined;
}

export type RoleResolutionStatus = "class" | "fallback" | "none";

export interface RoleResolution {
	status: RoleResolutionStatus;
	selector?: string;
}

function canonicalSelector(value: string): string {
	return value.trim().replace(/:.+$/, "");
}

function findInventoryModel(value: string, inventory: readonly InventoryModel[]): InventoryModel | undefined {
	const selector = canonicalSelector(value);
	const slash = selector.indexOf("/");
	return inventory.find(model => {
		const fullSelector = `${model.provider}/${model.id}`;
		if (fullSelector.toLowerCase() === selector.toLowerCase()) return true;
		return slash < 0 && model.id.toLowerCase() === selector.toLowerCase();
	});
}

function resolveConfiguredSelector(
	value: string | undefined,
	roleLookup: RoleLookup,
	inventory: readonly InventoryModel[],
	seenRoles: Set<string>,
): string | undefined {
	if (!value?.trim()) return undefined;
	const normalized = value.trim();
	if (normalized.startsWith("@")) {
		const role = normalized.slice(1);
		if (seenRoles.has(role)) return undefined;
		seenRoles.add(role);
		return resolveConfiguredSelector(roleLookup.getModelRole(role), roleLookup, inventory, seenRoles);
	}
	return findInventoryModel(normalized, inventory)?.selector;
}

/** Resolve a class-role then standard-fallback chain against a supplied inventory. */
export function resolveRoleChain(
	entry: ModelRoleEntry,
	roleLookup: RoleLookup,
	inventory: readonly InventoryModel[],
	resolveSelector: (value: string | undefined) => string | undefined = value =>
		resolveConfiguredSelector(value, roleLookup, inventory, new Set<string>()),
): RoleResolution {
	const classSelector = resolveSelector(roleLookup.getModelRole(entry.role));
	if (classSelector) return { status: "class", selector: classSelector };
	const fallbackRole = entry.standardFallback.slice(1);
	const fallbackValue = roleLookup.getModelRole(fallbackRole) ?? entry.standardFallback;
	const fallbackSelector = resolveSelector(fallbackValue);
	if (fallbackSelector) return { status: "fallback", selector: fallbackSelector };
	return { status: "none" };
}

export interface ResearchRequest {
	kind: "omp-model-role-research-request";
	schemaVersion: 1;
	requestedAt: string;
	roles: ModelRoleEntry[];
	availableModels: InventoryModel[];
}

export interface BenchmarkSource {
	url: string;
	title: string;
	retrievedAt: string;
	publishedAt?: string;
	caveat: string;
}

export interface ResearchRecommendation {
	role: string;
	modelSelector: string;
	fit: string;
	rationale: string;
	benchmarkSources: BenchmarkSource[];
	confidence: "low" | "medium" | "high";
}

export interface ResearchResponse {
	kind: "omp-model-role-recommendations";
	schemaVersion: 1;
	generatedAt: string;
	recommendations: ResearchRecommendation[];
	unavailableRoles: Array<{ role: string; reason: string }>;
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
	if (!isNonEmptyString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
	return Number.isFinite(Date.parse(value));
}

function isHttpUrl(value: unknown): value is string {
	if (!isNonEmptyString(value)) return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isInventoryModel(value: unknown): value is InventoryModel {
	return (
		isRecord(value) &&
		isNonEmptyString(value.selector) &&
		isNonEmptyString(value.provider) &&
		isNonEmptyString(value.id) &&
		isNonEmptyString(value.name) &&
		(value.contextWindow === null || typeof value.contextWindow === "number") &&
		(value.maxTokens === null || typeof value.maxTokens === "number") &&
		typeof value.reasoning === "boolean"
	);
}

/** Validate the strict delegated-research request contract. */
export function isResearchRequest(value: unknown): value is ResearchRequest {
	if (!isRecord(value) || value.kind !== "omp-model-role-research-request" || value.schemaVersion !== 1) return false;
	if (!isIsoTimestamp(value.requestedAt) || !Array.isArray(value.roles) || !Array.isArray(value.availableModels)) return false;
	return value.roles.every(role => {
		if (!isRecord(role)) return false;
		return (
			typeof role.role === "string" &&
			Array.isArray(role.agents) &&
			role.agents.every(agent => typeof agent === "string") &&
			typeof role.standardFallback === "string"
		);
	}) && value.availableModels.every(isInventoryModel);
}

function isBenchmarkSource(value: unknown): value is BenchmarkSource {
	return (
		isRecord(value) &&
		isHttpUrl(value.url) &&
		isNonEmptyString(value.title) &&
		isIsoTimestamp(value.retrievedAt) &&
		(value.publishedAt === undefined || isIsoTimestamp(value.publishedAt)) &&
		isNonEmptyString(value.caveat)
	);
}

/** Validate recommendations and reject selectors absent from the live inventory. */
export function isResearchResponse(value: unknown, inventory: readonly InventoryModel[]): value is ResearchResponse {
	if (!isRecord(value) || value.kind !== "omp-model-role-recommendations" || value.schemaVersion !== 1) return false;
	if (
		!isIsoTimestamp(value.generatedAt) ||
		!Array.isArray(value.recommendations) ||
		!Array.isArray(value.unavailableRoles) ||
		!Array.isArray(value.warnings)
	) return false;
	const selectors = new Set(inventory.map(model => model.selector));
	const knownRoles = new Set(defaultFullstackModelRoles.map(entry => entry.role));
	const responseRoles = new Set<string>();
	for (const recommendation of value.recommendations) {
		if (!isRecord(recommendation) || !isNonEmptyString(recommendation.role) || !knownRoles.has(recommendation.role)) return false;
		if (responseRoles.has(recommendation.role)) return false;
		responseRoles.add(recommendation.role);
		if (
			!isNonEmptyString(recommendation.modelSelector) ||
			!selectors.has(recommendation.modelSelector) ||
			!isNonEmptyString(recommendation.fit) ||
			!isNonEmptyString(recommendation.rationale) ||
			!Array.isArray(recommendation.benchmarkSources) ||
			recommendation.benchmarkSources.length === 0 ||
			!recommendation.benchmarkSources.every(isBenchmarkSource) ||
			(recommendation.confidence !== "low" && recommendation.confidence !== "medium" && recommendation.confidence !== "high")
		) return false;
	}
	for (const unavailableRole of value.unavailableRoles) {
		if (!isRecord(unavailableRole) || !isNonEmptyString(unavailableRole.role) || !knownRoles.has(unavailableRole.role)) return false;
		if (responseRoles.has(unavailableRole.role) || !isNonEmptyString(unavailableRole.reason)) return false;
		responseRoles.add(unavailableRole.role);
	}
	return value.warnings.every(isNonEmptyString);
}

export const validateResearchRequest = isResearchRequest;
export const validateResearchResponse = isResearchResponse;