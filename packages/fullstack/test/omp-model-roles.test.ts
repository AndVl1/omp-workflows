import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import modelRolesFactory, { MAX_RESEARCH_PROMPT_BYTES } from "../commands/omp-model-roles/index.js";
import {
	MODEL_ROLES,
	BUILTIN_ROLES,
	type InventoryModel,
	isResearchRequest,
	isResearchResponse,
	resolveRoleChain,
} from "../commands/omp-model-roles/_roles.js";
const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const now = "2026-08-02T12:00:00.000Z";

const inventory: InventoryModel[] = [
	{
		selector: "test/class-model",
		provider: "test",
		id: "class-model",
		name: "Class model",
		contextWindow: 128000,
		maxTokens: 8192,
		reasoning: true,
	},
	{
		selector: "test/fallback-model",
		provider: "test",
		id: "fallback-model",
		name: "Fallback model",
		contextWindow: 128000,
		maxTokens: 8192,
		reasoning: false,
	},
];

function roleLookup(values: Record<string, string | undefined>) {
	return { getModelRole: (role: string) => values[role] };
}

function createSettings(options: { fail?: boolean; overrides?: Record<string, string> } = {}) {
	if (options.fail) throw new Error("settings failed");
	const roles: Record<string, string> = {
		architect: "test/class-model",
		slow: "test/fallback-model",
		task: "test/fallback-model",
		smol: "test/fallback-model",
	};
	return {
		getModelRole: (role: string) => roles[role],
		getModelRoleSource: () => "project",
		get: (path: string) => path === "task.agentModelOverrides" ? options.overrides ?? {} : undefined,
	};
}

function createApi(options: { cwd?: string; settingsFailure?: boolean; overrides?: Record<string, string> } = {}) {
	let execCalls = 0;
	const api = {
		cwd: options.cwd ?? packageRoot,
		exec: async () => {
			execCalls += 1;
			return { stdout: "", stderr: "", exitCode: 0 };
		},
		typebox: {},
		arktype: {},
		zod: {},
		pi: {
			Settings: {
				loadReadOnly: async () => createSettings({ fail: options.settingsFailure, overrides: options.overrides }),
			},
		},
	};
	return { api, getExecCalls: () => execCalls };
}

function createContext(options: { cwd?: string; models?: readonly unknown[]; registryFailure?: boolean; notifyFailure?: boolean } = {}) {
	const notifications: Array<[string, string]> = [];
	return {
		ctx: {
			cwd: options.cwd ?? packageRoot,
			ui: {
				notify: (message: string, type: string) => {
					if (options.notifyFailure) throw new Error("notify failed");
					notifications.push([message, type]);
				},
			},
			modelRegistry: {
				getAvailable: () => {
					if (options.registryFailure) throw new Error("registry failed");
					return options.models ?? inventory;
				},
			},
		},
		notifications,
	};
}

function validResearchResponse() {
	return {
		kind: "omp-model-role-recommendations",
		schemaVersion: 1,
		generatedAt: now,
		recommendations: [
			{
				role: "architect",
				modelSelector: "test/class-model",
				fit: "Strong architectural reasoning",
				rationale: "Fresh benchmark evidence supports this model.",
				benchmarkSources: [
					{
						url: "https://example.com/benchmark",
						title: "Benchmark report",
						retrievedAt: now,
						publishedAt: "2026-08-01T09:30:00+00:00",
						caveat: "Synthetic benchmark results may not predict every repository workload.",
					},
				],
				confidence: "high",
			},
		],
		unavailableRoles: [{ role: "reviewer", reason: "No independent benchmark evidence found." }],
		warnings: ["Coverage is limited to public benchmark results."],
	};
}

function responseWith(mutator: (response: ReturnType<typeof validResearchResponse>) => void) {
	const response = structuredClone(validResearchResponse());
	mutator(response);
	return response;
}

test("model role chain resolves class role before fallback", () => {
	const entry = { role: "example", agents: ["agent"], standardFallback: "@task" };
	const result = resolveRoleChain(entry, roleLookup({ example: "test/class-model", task: "test/fallback-model" }), inventory);
	assert.deepEqual(result, { status: "class", selector: "test/class-model" });
});

test("model role chain resolves fallback when class role is not configured", () => {
	const entry = { role: "example", agents: ["agent"], standardFallback: "@task" };
	const result = resolveRoleChain(entry, roleLookup({ task: "test/fallback-model" }), inventory);
	assert.deepEqual(result, { status: "fallback", selector: "test/fallback-model" });
});

test("model role chain returns none when neither selector resolves", () => {
	const entry = { role: "example", agents: ["agent"], standardFallback: "@task" };
	const result = resolveRoleChain(entry, roleLookup({}), inventory);
	assert.deepEqual(result, { status: "none" });
});

test("custom role names do not overlap built-in roles", () => {
	const overlap = MODEL_ROLES.map(entry => entry.role).filter(role => BUILTIN_ROLES.includes(role));
	assert.deepEqual(overlap, []);
});

test("every bundled agent frontmatter contains class role followed by standard fallback", () => {
	const agentsDirectory = join(packageRoot, "agents");
	for (const entry of MODEL_ROLES) {
		for (const agent of entry.agents) {
			const frontmatter = readFileSync(join(agentsDirectory, `${agent}.md`), "utf8");
			const match = frontmatter.match(/^model:\s*\[\s*"(@[^\"]+)"\s*,\s*"(@[^\"]+)"\s*\]/m);
			assert.ok(match, `${agent} must define a two-pattern model array`);
			assert.equal(match?.[1], `@${entry.role}`, `${agent} class role`);
			assert.equal(match?.[2], entry.standardFallback, `${agent} fallback role`);
		}
	}
});

test("native resolveAgentModelPatterns enforces request, settings override, then frontmatter precedence", { skip: !bunAvailable && "Bun is not installed; OMP native TypeScript modules require its runtime" }, () => {
	const script = `
		import { resolveAgentModelPatterns } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
		const settings = { getModelRole: role => ({ architect: "test/class-model", slow: "test/fallback-model" })[role] };
		const frontmatter = ["@architect", "@slow"];
		const request = resolveAgentModelPatterns({ settingsOverride: "test/request-model", agentModel: frontmatter, settings });
		const settingsOverride = resolveAgentModelPatterns({ settingsOverride: "test/settings-override", agentModel: frontmatter, settings });
		const frontmatterOnly = resolveAgentModelPatterns({ agentModel: frontmatter, settings });
		console.log(JSON.stringify({ request, settingsOverride, frontmatterOnly }));
	`;
	const output = execFileSync("bun", ["--eval", script], { cwd: packageRoot, encoding: "utf8" });
	assert.deepEqual(JSON.parse(output), {
		request: ["test/request-model"],
		settingsOverride: ["test/settings-override"],
		frontmatterOnly: ["test/class-model", "test/fallback-model"],
	});
});

test("research request schema accepts a complete request and rejects a non-ISO timestamp", () => {
	const request = {
		kind: "omp-model-role-research-request",
		schemaVersion: 1,
		requestedAt: now,
		roles: MODEL_ROLES,
		availableModels: inventory,
	};
	assert.equal(isResearchRequest(request), true);
	assert.equal(isResearchRequest({ ...request, requestedAt: "today" }), false);
});

test("research response schema accepts a fully valid response", () => {
	assert.equal(isResearchResponse(validResearchResponse(), inventory), true);
});

test("research response rejects a non-ISO generatedAt timestamp", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.generatedAt = "yesterday"; }), inventory), false);
});

test("research response rejects empty fit", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.recommendations[0]!.fit = "  "; }), inventory), false);
});

test("research response rejects empty rationale", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.recommendations[0]!.rationale = ""; }), inventory), false);
});

test("research response rejects recommendations without benchmark sources", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.recommendations[0]!.benchmarkSources = []; }), inventory), false);
});

test("research response rejects a missing source caveat", () => {
	const response = validResearchResponse() as unknown as { recommendations: Array<{ benchmarkSources: Array<Record<string, unknown>> }> };
	delete response.recommendations[0]!.benchmarkSources[0]!.caveat;
	assert.equal(isResearchResponse(response, inventory), false);
});

test("research response rejects a non-http source URL", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.recommendations[0]!.benchmarkSources[0]!.url = "ftp://example.com"; }), inventory), false);
});

test("research response rejects an empty source title", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.recommendations[0]!.benchmarkSources[0]!.title = ""; }), inventory), false);
});

test("research response rejects a non-ISO source retrievedAt", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.recommendations[0]!.benchmarkSources[0]!.retrievedAt = "2026-08-02"; }), inventory), false);
});

test("research response rejects a non-ISO optional publishedAt", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.recommendations[0]!.benchmarkSources[0]!.publishedAt = "last week"; }), inventory), false);
});


test("research response rejects an unknown unavailable role", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.unavailableRoles[0]!.role = "invented"; }), inventory), false);
});

test("research response rejects an unknown recommendation role", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.recommendations[0]!.role = "invented"; }), inventory), false);
});

test("research response rejects an empty unavailable reason", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.unavailableRoles[0]!.reason = ""; }), inventory), false);
});


test("research response rejects duplicate roles across result sections", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.unavailableRoles[0]!.role = "architect"; }), inventory), false);
});

test("research response rejects duplicate recommendation roles", () => {
	const response = validResearchResponse();
	response.recommendations.push(structuredClone(response.recommendations[0]!));
	assert.equal(isResearchResponse(response, inventory), false);
});

test("research response rejects a selector outside the immutable inventory", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.recommendations[0]!.modelSelector = "test/invented"; }), inventory), false);
});

test("research response rejects empty warnings", () => {
	assert.equal(isResearchResponse(responseWith(response => { response.warnings[0] = " "; }), inventory), false);
});

test("execute validate reads settings and registry without mutation", async () => {
	const { api, getExecCalls } = createApi();
	const { ctx, notifications } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.match(result, /\/omp-model-roles validate \(2 available models\)/);
	assert.match(result, /use \/model without arguments/);
	assert.match(result, /use \/switch \(Alt\+P\)/);
	assert.equal(getExecCalls(), 0);
	assert.deepEqual(notifications.at(-1), ["omp-model-roles: validation complete", "warning"]);
});

test("execute recommendations returns a closed strict validation contract", async () => {
	const { api } = createApi();
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["recommendations"], ctx as never);
	assert.match(result, /schemaMode:'strict'/);
	assert.match(result, /outputSchema:/);
	assert.match(result, /validateResearchResponse\(candidate, immutableInventorySnapshot\)/);
	assert.match(result, /Reject the ENTIRE response/);
	assert.match(result, /DEGRADED OUTPUT/);
	assert.match(result, /malformed\/multiple JSON objects/);
	assert.match(result, /web_search failure/);
	assert.match(result, /cancellation/);
});

test("execute recommendations deduplicates and bounds a huge registry prompt", async () => {
	const largeModels = Array.from({ length: 10_000 }, (_, index) => ({
		provider: `provider-${index}`,
		id: `model-${index}`,
		name: "N".repeat(128),
		contextWindow: 128000,
		maxTokens: 8192,
		reasoning: index % 2 === 0,
		thinking: { nested: "x".repeat(20_000) },
		cost: { nested: "y".repeat(20_000) },
	}));
	largeModels.unshift(largeModels[0]!);
	const { api } = createApi();
	const { ctx } = createContext({ models: largeModels });
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["recommendations"], ctx as never);
	assert.ok(Buffer.byteLength(result) <= MAX_RESEARCH_PROMPT_BYTES + 16_000, `prompt was ${Buffer.byteLength(result)} bytes`);
	assert.match(result, /inventory snapshot truncated from 10000 to/);
	assert.doesNotMatch(result, /"thinking"|"cost"/);
});

test("execute recommendations does not dispatch research when registry has zero models", async () => {
	const { api, getExecCalls } = createApi();
	const { ctx } = createContext({ models: [] });
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["recommendations"], ctx as never);
	assert.match(result, /research was not dispatched/);
	assert.doesNotMatch(result, /Call task\(/);
	assert.equal(getExecCalls(), 0);
});

test("execute degrades safely without cwd", async () => {
	const { api } = createApi({ cwd: "" });
	const { ctx } = createContext({ cwd: "" });
	const target = modelRolesFactory({ ...api, cwd: "" } as never);
	const result = await target.execute(["validate"], { ...ctx, cwd: "" } as never);
	assert.match(result, /validate \(degraded\)/);
	assert.match(result, /no cwd available/);
});

test("execute degrades safely when settings loading fails", async () => {
	const { api } = createApi({ settingsFailure: true });
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.match(result, /validate \(degraded\)/);
	assert.match(result, /settings unavailable: settings failed/);
});

test("execute degrades safely when registry access fails", async () => {
	const { api } = createApi();
	const { ctx } = createContext({ registryFailure: true });
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.match(result, /validate \(degraded\)/);
	assert.match(result, /model registry unavailable: registry failed/);
});

test("execute remains exit-safe when UI notify throws", async () => {
	const { api } = createApi();
	const { ctx } = createContext({ notifyFailure: true });
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.match(result, /\/omp-model-roles validate/);
	assert.doesNotMatch(result, /unexpected validation failure/);
});

test("command source contains no mutation APIs", () => {
	const source = readFileSync(join(packageRoot, "commands", "omp-model-roles", "index.ts"), "utf8");
	assert.doesNotMatch(source, /setModelRole|setProjectModelRole|writeFile|appendFile|mkdir|rmSync|api\.exec/);
});
