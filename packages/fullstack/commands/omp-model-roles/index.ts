import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import {
	BUILTIN_ROLES,
	MODEL_ROLES,
	type InventoryModel,
	type ModelRoleEntry,
	resolveRoleChain,
} from "./_roles.js";

const AGENT_FILE_COUNT = 17;
const MAX_INVENTORY_MODELS = 128;
const MAX_RESEARCH_INVENTORY_BYTES = 48_000;
export const MAX_RESEARCH_PROMPT_BYTES = 96_000;
const MAX_PROVIDER_LENGTH = 96;
const MAX_MODEL_ID_LENGTH = 192;
const MAX_MODEL_NAME_LENGTH = 128;
const FRONTMATTER_ROLE_PATTERN = /^model:\s*\[\s*"(@[^\"]+)"\s*,\s*"(@[^\"]+)"\s*\]\s*$/m;
const USAGE = 'Usage: /omp-model-roles [validate|recommendations] — type "recommendations" to get model suggestions for your available models, or "validate" to check current role config';

interface SettingsLike {
	getModelRole?: (role: string) => string | undefined;
	getModelRoleSource?: (role: string) => string;
	get?: (path: string) => unknown;
}

interface ModelResolverModule {
	resolveModelRoleValue?: (
		roleValue: string | undefined,
		availableModels: readonly unknown[],
		options?: { settings?: unknown; roleLookup?: unknown },
	) => { model?: { provider?: string; id?: string }; warning?: string };
}

interface ValidationData {
	settings: SettingsLike | undefined;
	inventory: InventoryModel[];
	resolver: ModelResolverModule | undefined;
	warnings: string[];
	frontmatterWarning?: string;
}

function notify(ctx: HookCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui?.notify?.(message, type);
	} catch {
		// UI notifications are advisory and must never break the command result.
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizedMetadata(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > maxLength) return undefined;
	return normalized;
}

function finiteMetric(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function serializeModel(model: unknown): InventoryModel | undefined {
	const value = asRecord(model);
	const provider = normalizedMetadata(value.provider, MAX_PROVIDER_LENGTH);
	const id = normalizedMetadata(value.id, MAX_MODEL_ID_LENGTH);
	if (!provider || !id) return undefined;
	return {
		selector: `${provider}/${id}`,
		provider,
		id,
		name: normalizedMetadata(value.name, MAX_MODEL_NAME_LENGTH) ?? id,
		contextWindow: finiteMetric(value.contextWindow),
		maxTokens: finiteMetric(value.maxTokens),
		reasoning: value.reasoning === true,
	};
}

function uniqueInventory(models: readonly unknown[]): InventoryModel[] {
	const selectors = new Set<string>();
	const inventory: InventoryModel[] = [];
	for (const model of models) {
		const serialized = serializeModel(model);
		if (!serialized || selectors.has(serialized.selector)) continue;
		selectors.add(serialized.selector);
		inventory.push(serialized);
	}
	return inventory;
}

function settingsRoleLookup(settings: SettingsLike | undefined): { getModelRole(role: string): string | undefined } {
	return { getModelRole: role => settings?.getModelRole?.(role) };
}

function selectorFromNative(value: string | undefined, data: ValidationData): string | undefined {
	if (!value?.trim() || !data.resolver?.resolveModelRoleValue) return undefined;
	try {
		const result = data.resolver.resolveModelRoleValue(value, data.inventory as unknown[], {
			settings: data.settings,
			roleLookup: settingsRoleLookup(data.settings),
		});
		if (!result.model?.provider || !result.model.id) return undefined;
		return `${result.model.provider}/${result.model.id}`;
	} catch (error) {
		data.warnings.push(`native resolver failed for ${value}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function resolveEntry(entry: ModelRoleEntry, data: ValidationData): { status: "class" | "fallback" | "none"; selector?: string } {
	const roleLookup = settingsRoleLookup(data.settings);
	if (data.resolver?.resolveModelRoleValue) {
		const classSelector = selectorFromNative(data.settings?.getModelRole?.(entry.role), data);
		if (classSelector) return { status: "class", selector: classSelector };
		const fallbackSelector = selectorFromNative(entry.standardFallback, data);
		if (fallbackSelector) return { status: "fallback", selector: fallbackSelector };
		return { status: "none" };
	}
	return resolveRoleChain(entry, roleLookup, data.inventory);
}

function findAgentsDirectory(cwd: string): string | undefined {
	const sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
	const candidates = [
		sourceDirectory,
		resolve(cwd, "node_modules", "@andvl1", "omp-workflows-fullstack", "agents"),
		resolve(cwd, "agents"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	try {
		return readdirSync(dirname(cwd), { withFileTypes: true })
			.filter(entry => entry.isDirectory() && entry.name.startsWith("omp-workflows-fullstack"))
			.map(entry => resolve(dirname(cwd), entry.name, "agents"))
			.find(candidate => existsSync(candidate));
	} catch {
		return undefined;
	}
}

function validateFrontmatter(cwd: string): string | undefined {
	const agentsDirectory = findAgentsDirectory(cwd);
	if (!agentsDirectory) return "map-only validation: bundled agents directory is unavailable";
	for (const entry of MODEL_ROLES) {
		for (const agent of entry.agents) {
			const path = join(agentsDirectory, `${agent}.md`);
			if (!existsSync(path)) return `frontmatter warning: missing ${path}`;
			const match = FRONTMATTER_ROLE_PATTERN.exec(readFileSync(path, "utf8"));
			if (!match || match[1] !== `@${entry.role}` || match[2] !== entry.standardFallback) {
				return `frontmatter warning: ${agent}.md must use model: ["@${entry.role}", "${entry.standardFallback}"]`;
			}
		}
	}
	const count = MODEL_ROLES.reduce((total, entry) => total + entry.agents.length, 0);
	return count === AGENT_FILE_COUNT ? undefined : `frontmatter warning: expected ${AGENT_FILE_COUNT} agents, found ${count}`;
}

async function loadSettings(api: CustomCommandAPI, cwd: string): Promise<SettingsLike> {
	const settings = asRecord(api.pi).Settings as { loadReadOnly?: (options: { cwd: string }) => Promise<SettingsLike> } | undefined;
	if (!settings?.loadReadOnly) throw new Error("Settings.loadReadOnly is unavailable");
	return settings.loadReadOnly({ cwd });
}

async function loadResolver(data: ValidationData): Promise<void> {
	try {
		// Optional deep import keeps the command usable with older OMP installations.
		data.resolver = (await import("@oh-my-pi/pi-coding-agent/config/model-resolver") as unknown) as ModelResolverModule;
	} catch (error) {
		data.warnings.push(`native model resolver unavailable; using inventory matching (${error instanceof Error ? error.message : String(error)})`);
	}
}

function modelRoleSource(settings: SettingsLike | undefined, role: string): string {
	try {
		return settings?.getModelRoleSource?.(role) ?? "effective";
	} catch {
		return "effective";
	}
}
function overridesForAgents(settings: SettingsLike | undefined): string[] {
	try {
		const overrides = settings?.get?.("task.agentModelOverrides");
		if (!overrides || typeof overrides !== "object") return [];
		const names = new Set(MODEL_ROLES.flatMap(entry => entry.agents));
		return Object.keys(overrides as Record<string, unknown>).filter(agent => names.has(agent));
	} catch {
		return [];
	}
}

function truncate(value: string, maxLength = 64): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function nativeModelHelp(): string {
	return "In the interactive TUI, use /model without arguments to open the native Model Hub and assign project/global roles; use /switch (Alt+P) for a session-only switch. On ACP/text command surfaces, /model <id> performs a quick session switch.";
}

function degradedReport(warnings: string[]): string {
	const lines = ["/omp-model-roles validate (degraded)", "role | agents | fallback | status | config-value | source"];
	for (const entry of MODEL_ROLES) {
		lines.push(`${entry.role} | ${entry.agents.join(",")} | ${entry.standardFallback} | none | — | unavailable`);
	}
	lines.push(`WARN: ${warnings.join("; ") || "validation unavailable"}`);
	lines.push(nativeModelHelp());
	return lines.join("\n");
}

async function collectValidation(api: CustomCommandAPI, ctx: HookCommandContext, cwd: string): Promise<{ report: string; data: ValidationData }> {
	const warnings: string[] = [];
	const data: ValidationData = { settings: undefined, inventory: [], resolver: undefined, warnings };
	try {
		data.settings = await loadSettings(api, cwd);
	} catch (error) {
		warnings.push(`settings unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const models = ctx.modelRegistry?.getAvailable?.() ?? [];
		data.inventory = uniqueInventory(models);
		if (data.inventory.length === 0) warnings.push("model registry has no available models");
	} catch (error) {
		warnings.push(`model registry unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!data.settings || data.inventory.length === 0) {
		notify(ctx, "omp-model-roles: validation degraded", "warning");
		return { report: degradedReport(warnings), data };
	}
	await loadResolver(data);
	data.frontmatterWarning = validateFrontmatter(cwd);
	if (data.frontmatterWarning) warnings.push(data.frontmatterWarning);
	const conflicts = MODEL_ROLES.map(entry => entry.role).filter(role => BUILTIN_ROLES.includes(role));
	if (conflicts.length > 0) warnings.push(`ERROR: custom roles overlap built-ins: ${conflicts.join(", ")}`);
	const overriddenAgents = overridesForAgents(data.settings);
	if (overriddenAgents.length > 0) {
		warnings.push(`INFO: task.agentModelOverrides takes priority for: ${overriddenAgents.join(", ")}`);
	}
	const lines = [
		`/omp-model-roles validate (${data.inventory.length} available models)`,
		"role | agents | fallback | status | config-value | source",
	];
	for (const entry of MODEL_ROLES) {
		const configValue = data.settings.getModelRole?.(entry.role) ?? "—";
		if (configValue === "—") warnings.push(`role ${entry.role} is not configured; using ${entry.standardFallback} fallback when available`);
		const resolution = resolveEntry(entry, data);
		lines.push(
			`${entry.role} | ${entry.agents.join(",")} | ${entry.standardFallback} | ${resolution.status}${resolution.selector ? ` (${truncate(resolution.selector)})` : ""} | ${truncate(configValue)} | ${modelRoleSource(data.settings, entry.role)}`,
		);
	}
	if (warnings.length > 0) lines.push(...warnings.map(warning => `WARN: ${truncate(warning, 180)}`));
	lines.push(nativeModelHelp());
	notify(ctx, "omp-model-roles: validation complete", warnings.length > 0 ? "warning" : "info");
	return { report: lines.join("\n"), data };
}
interface BoundedInventory {
	models: InventoryModel[];
	total: number;
	truncated: boolean;
}

function boundedResearchInventory(inventory: readonly InventoryModel[]): BoundedInventory {
	const models: InventoryModel[] = [];
	let jsonBytes = 2;
	for (const model of inventory) {
		const modelBytes = Buffer.byteLength(JSON.stringify(model)) + (models.length === 0 ? 0 : 1);
		if (models.length >= MAX_INVENTORY_MODELS || jsonBytes + modelBytes > MAX_RESEARCH_INVENTORY_BYTES) break;
		models.push(model);
		jsonBytes += modelBytes;
	}
	return { models, total: inventory.length, truncated: models.length < inventory.length };
}

function researchOutputSchema(selectors: readonly string[]): Record<string, unknown> {
	const roleEnum = MODEL_ROLES.map(entry => entry.role);
	const source = {
		type: "object",
		additionalProperties: false,
		required: ["url", "title", "retrievedAt", "caveat"],
		properties: {
			url: { type: "string", pattern: "^https?://" },
			title: { type: "string", minLength: 1 },
			retrievedAt: { type: "string", format: "date-time" },
			publishedAt: { type: "string", format: "date-time" },
			caveat: { type: "string", minLength: 1 },
		},
	};
	return {
		type: "object",
		additionalProperties: false,
		required: ["kind", "schemaVersion", "generatedAt", "recommendations", "unavailableRoles", "warnings"],
		properties: {
			kind: { const: "omp-model-role-recommendations" },
			schemaVersion: { const: 1 },
			generatedAt: { type: "string", format: "date-time" },
			recommendations: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["role", "modelSelector", "fit", "rationale", "benchmarkSources", "confidence"],
					properties: {
						role: { type: "string", enum: roleEnum },
						modelSelector: { type: "string", enum: selectors },
						fit: { type: "string", minLength: 1 },
						rationale: { type: "string", minLength: 1 },
						benchmarkSources: { type: "array", minItems: 1, items: source },
						confidence: { type: "string", enum: ["low", "medium", "high"] },
					},
				},
			},
			unavailableRoles: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["role", "reason"],
					properties: { role: { type: "string", enum: roleEnum }, reason: { type: "string", minLength: 1 } },
				},
			},
			warnings: { type: "array", items: { type: "string", minLength: 1 } },
		},
	};
}

export function buildResearchPrompt(data: ValidationData): string {
	const bounded = boundedResearchInventory(data.inventory);
	const immutableInventoryJson = JSON.stringify(bounded.models);
	const request = {
		kind: "omp-model-role-research-request",
		schemaVersion: 1,
		requestedAt: new Date().toISOString(),
		roles: MODEL_ROLES,
		availableModels: bounded.models,
	};
	const outputSchema = researchOutputSchema(bounded.models.map(model => model.selector));
	const truncationWarning = bounded.truncated
		? `WARN: inventory snapshot truncated from ${bounded.total} to ${bounded.models.length} unique normalized models by the ${MAX_RESEARCH_INVENTORY_BYTES}-byte/${MAX_INVENTORY_MODELS}-model budget; recommendations cover only the included snapshot.`
		: "Inventory snapshot is complete.";
	const prompt = [
		"ORCHESTRATION CONTRACT — complete every step; never present unvalidated researcher output as recommendations:",
		`1. Save this exact immutable inventory snapshot before dispatch: ${immutableInventoryJson}`,
		`2. Call task({agent:'tech-researcher', task:<researchPrompt>, outputSchema:${JSON.stringify(outputSchema)}, schemaMode:'strict'}).`,
		"3. Require fresh web_search benchmarks and selectors exclusively from the saved snapshot. The researcher must return exactly one JSON object, without markdown.",
		"4. After task returns, extract exactly one JSON object from its structured result. Import and apply validateResearchResponse(candidate, immutableInventorySnapshot) from commands/omp-model-roles/_roles.js. Also re-check role and selector membership against that snapshot. Reject the ENTIRE response if parsing, schema validation, uniqueness, membership, or source validation fails.",
		"5. Only after validation succeeds, render the validated recommendations and unavailable roles. Never render entries from a rejected response.",
		"6. DEGRADED OUTPUT: on malformed/multiple JSON objects, strict-schema failure, invented selector/role, empty required data, web_search failure, task error, or cancellation, render only: 'WARN: model-role recommendations unavailable: <reason>; no recommendations were accepted.' Do not render a recommendations table. For web failure, the researcher may instead return affected roles in unavailableRoles with evidence warnings, but those must still pass validation.",
		truncationWarning,
		"RESEARCH_REQUEST_JSON:",
		JSON.stringify(request),
	].join("\n");
	if (Buffer.byteLength(prompt) > MAX_RESEARCH_PROMPT_BYTES) throw new Error("bounded recommendations prompt exceeded its hard size limit");
	return prompt;
}

const factory = (api: CustomCommandAPI): CustomCommand => ({
	name: "omp-model-roles",
	description: "Validate per-agent model roles or delegate fresh model recommendations.",
	async execute(args: string[], ctx: HookCommandContext): Promise<string> {
		const isDefault = args.length === 0;
		const action = isDefault ? "validate" : args.length === 1 ? args[0] : undefined;
		if (action !== "validate" && action !== "recommendations") return USAGE;
		const wrap = (report: string): string => (isDefault ? `${USAGE}\n${report}` : report);
		const cwd = ctx.cwd ?? api.cwd;
		if (!cwd) {
			const report = degradedReport(["no cwd available"]);
			notify(ctx, "omp-model-roles: no cwd available", "warning");
			return wrap(report);
		}
		try {
			const validation = await collectValidation(api, ctx, cwd);
			if (action === "validate") return wrap(validation.report);
			if (validation.data.inventory.length === 0) {
				return wrap(`${validation.report}\nWARN: model-role recommendations unavailable: no validated models in the inventory; research was not dispatched.`);
			}
			return wrap(`${validation.report}\n\n${buildResearchPrompt(validation.data)}`);
		} catch (error) {
			const report = degradedReport([`unexpected validation failure: ${error instanceof Error ? error.message : String(error)}`]);
			notify(ctx, "omp-model-roles: unexpected validation failure", "warning");
			return wrap(report);
		}
	},
});

export { factory as default };
export { FRONTMATTER_ROLE_PATTERN };
