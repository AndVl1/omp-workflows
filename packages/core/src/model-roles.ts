/**
 * Generic model-role contracts shared across bundles.
 *
 * Core deliberately does not ship a default taxonomy. A bundle supplies its
 * own role entries when it resolves model classes or validates research
 * recommendations.
 */

export interface ModelRoleEntry {
	role: string;
	agents: string[];
	standardFallback: string;
}

/** A caller-supplied taxonomy; core never selects a product-specific default. */
export type ModelRoleTaxonomy = readonly ModelRoleEntry[];
export interface ModelRolePreset {
	name: string;
	roles: ModelRoleTaxonomy;
}


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
/** Validate recommendations against a caller-supplied taxonomy and inventory. */
export function isResearchResponse(
	value: unknown,
	inventory: readonly InventoryModel[],
	taxonomy: ModelRoleTaxonomy = [],
): value is ResearchResponse {
	if (!isRecord(value) || value.kind !== "omp-model-role-recommendations" || value.schemaVersion !== 1) return false;
	if (
		!isIsoTimestamp(value.generatedAt) ||
		!Array.isArray(value.recommendations) ||
		!Array.isArray(value.unavailableRoles) ||
		!Array.isArray(value.warnings)
	) return false;
	const selectors = new Set(inventory.map(model => model.selector));
	const knownRoles = taxonomy.length > 0 ? new Set(taxonomy.map(entry => entry.role)) : undefined;
	const responseRoles = new Set<string>();
	for (const recommendation of value.recommendations) {
		if (!isRecord(recommendation) || !isNonEmptyString(recommendation.role)) return false;
		if (knownRoles && !knownRoles.has(recommendation.role)) return false;
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
		if (!isRecord(unavailableRole) || !isNonEmptyString(unavailableRole.role)) return false;
		if (knownRoles && !knownRoles.has(unavailableRole.role)) return false;
		if (responseRoles.has(unavailableRole.role) || !isNonEmptyString(unavailableRole.reason)) return false;
		responseRoles.add(unavailableRole.role);
	}
	return value.warnings.every(isNonEmptyString);
}
export const validateResearchRequest = isResearchRequest;
export const validateResearchResponse = isResearchResponse;