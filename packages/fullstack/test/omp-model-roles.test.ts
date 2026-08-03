import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import modelRolesFactory, { MAX_RESEARCH_PROMPT_BYTES } from "../commands/omp-model-roles/index.js";
import {
	defaultFullstackModelRoles as MODEL_ROLES,
	type InventoryModel,
	isResearchRequest,
	isResearchResponse,
	resolveRoleChain,
} from "@andvl1/omp-workflows-core";
import { BUILTIN_ROLES } from "../commands/omp-model-roles/index.js";
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

function createSettings(options: { fail?: boolean; overrides?: Record<string, string>; webSearchEnabled?: boolean } = {}) {
	if (options.fail) throw new Error("settings failed");
	const roles: Record<string, string> = {
		architect: "test/class-model",
		slow: "test/fallback-model",
		task: "test/fallback-model",
		smol: "test/fallback-model",
	};
	const extras: Record<string, unknown> = {};
	if (options.webSearchEnabled !== undefined) extras["web_search.enabled"] = options.webSearchEnabled;
	return {
		getModelRole: (role: string) => roles[role],
		getModelRoleSource: () => "project",
		get: (path: string) => {
			if (path === "task.agentModelOverrides") return options.overrides ?? {};
			return extras[path];
		},
	};
}
function createApi(options: { cwd?: string; settingsFailure?: boolean; overrides?: Record<string, string>; webSearchEnabled?: boolean } = {}) {
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
				loadReadOnly: async () => createSettings({ fail: options.settingsFailure, overrides: options.overrides, webSearchEnabled: options.webSearchEnabled }),
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

test("inventory chain resolveEntry returns class selector when configured model matches inventory", async () => {
	const { api } = createApi();
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	// architect is configured to test/class-model and that selector exists in inventory → class.
	assert.match(result, /\barchitect \| [^|]*\| class \(test\/class-model\)/);
	// developer-go is NOT configured; its standardFallback @task resolves to test/fallback-model → fallback.
	assert.match(result, /\bdeveloper-go \| [^|]*\| fallback \(test\/fallback-model\)/);
});

test("inventory chain resolveEntry falls back to standardFallback when the class role is not configured", async () => {
	const { api } = createApi();
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	// Every developer/qa/researcher agent whose class role is not configured must use @task/@smol/@slow fallback.
	assert.match(result, /\bdeveloper-go \| [^|]*\| [^|]*\| fallback \(test\/fallback-model\)/);
	assert.match(result, /\bdeveloper-kotlin \| [^|]*\| [^|]*\| fallback \(test\/fallback-model\)/);
	assert.match(result, /\bfrontend-developer \| [^|]*\| [^|]*\| fallback \(test\/fallback-model\)/);
	assert.match(result, /\bqa \| [^|]*\| [^|]*\| fallback \(test\/fallback-model\)/);
	assert.match(result, /\bresearcher \| [^|]*\| [^|]*\| fallback \(test\/fallback-model\)/);
});

test("inventory chain resolveEntry returns none when neither class nor fallback is in inventory", async () => {
	const restrictedInventory: InventoryModel[] = [
		{ selector: "test/other-model", provider: "test", id: "other-model", name: "Other", contextWindow: 8_000, maxTokens: 1_000, reasoning: false },
	];
	const { api } = createApi();
	const { ctx } = createContext({ models: restrictedInventory });
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	// Class selector test/class-model and fallback test/fallback-model are both absent → none.
	assert.match(result, /\barchitect \| [^|]*\| none\b/);
	assert.match(result, /\bdeveloper-go \| [^|]*\| none\b/);
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
	assert.match(result, /\/omp-model-roles validate \(2 available models, web_search=unknown\)/);
	assert.match(result, /use \/model without arguments/);
	assert.match(result, /use \/switch \(Alt\+P\)/);
	assert.equal(getExecCalls(), 0);
	assert.deepEqual(notifications.at(-1), ["omp-model-roles: validation complete", "warning"]);
});

test("execute recommendations returns an imperative delegated research contract", async () => {
	const { api } = createApi();
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["recommendations"], ctx as never);
	assert.match(result, /You MUST execute the steps below EXACTLY and in order/);
	assert.match(result, /Do NOT inspect local files/);
	assert.match(result, /agent="tech-researcher"/);
	assert.match(result, /schemaMode="strict"/);
	assert.match(result, /use web_search for fresh benchmarks/);
	assert.match(result, /final message MUST be exactly one JSON object/);
	assert.match(result, /kind must be omp-model-role-recommendations/);
	assert.match(result, /modelSelector must be present in the availableModels inventory/);
	assert.match(result, /DO NOT fabricate recommendations/);
	assert.match(result, /Your final message is the rendered table \(or the degraded notice\)/);
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

test("execute validate reports web_search=enabled header and INFO when toggle is on", async () => {
	const { api } = createApi({ webSearchEnabled: true });
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.match(result, /web_search=enabled/);
	assert.match(result, /INFO: web_search\.enabled=true/);
	assert.match(result, /HookCommandContext lacks authStorage\/ToolSession/);
});

test("execute validate reports web_search=disabled header and WARN when toggle is off", async () => {
	const { api } = createApi({ webSearchEnabled: false });
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.match(result, /web_search=disabled/);
	assert.match(result, /WARN: web_search disabled in settings/);
});

test("execute recommendations wraps the research contract in a marker envelope", async () => {
	const { api } = createApi();
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["recommendations"], ctx as never);
	assert.match(result, /^<<<omp-model-roles-research-request>>>\n/);
	assert.match(result, /\n<<<omp-model-roles-research-request-end>>>$/);
	// The inner payload must still contain the original research contract.
	const inner = result.replace(/^<<<omp-model-roles-research-request>>>\n/, "").replace(/\n<<<omp-model-roles-research-request-end>>>$/, "");
	assert.match(inner, /agent="tech-researcher"/);
	assert.match(inner, /RESEARCH_TASK_PAYLOAD_JSON:/);
});

test("execute validate is NOT wrapped in the research marker", async () => {
	const { api } = createApi();
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.doesNotMatch(result, /<<<omp-model-roles-research-request/);
});

test("ROLE_COUNT constant in the before_agent_start handler matches MODEL_ROLES.length", () => {
	// The marker handler in `packages/fullstack/src/index.ts` exposes
	// `details.roleCount` as a literal `ROLE_COUNT = 14` because the
	// handler's `tsconfig.json` has `rootDir=src` and cannot import
	// from `../commands/omp-model-roles/_roles.js` (TS6059). This test
	// is the bridge: bump `ROLE_COUNT` and `MODEL_ROLES` together.
	assert.equal(MODEL_ROLES.length, 14, "MODEL_ROLES length drifted from the handler's hard-coded ROLE_COUNT");
});

test("execute validate reports web_search=unknown header when toggle is unset", async () => {
	// When settings.get('web_search.enabled') returns a non-boolean (the toggle
	// is missing or wrong type), the diagnostic header must show
	// `web_search=unknown` and stay neutral (no INFO/WARN line is appended).
	const { api } = createApi();
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.match(result, /web_search=unknown/);
	assert.doesNotMatch(result, /web_search=(enabled|disabled)/);
	assert.doesNotMatch(result, /INFO: web_search\.enabled=true/);
	assert.doesNotMatch(result, /WARN: web_search disabled in settings/);
});

test("execute validate does not double-prefix warnings that already carry WARN/INFO/ERROR", async () => {
	// vp9-r5 — the legacy `WARN: ` prefix used to wrap every line, so
	// INFO/ERROR entries read as `WARN: INFO: …`. The fix detects an existing
	// prefix and only truncates; this test guards against a regression that
	// re-introduces the double prefix.
	const { api } = createApi({ webSearchEnabled: true });
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.doesNotMatch(result, /WARN: INFO: /);
	assert.doesNotMatch(result, /WARN: ERROR: /);
	assert.match(result, /INFO: web_search\.enabled=true/);
	assert.match(result, /INFO: resolving roles against available models inventory/);
});

test("execute validate does not double-prefix warnings that already carry WARN", async () => {
	// With web_search disabled the warning starts with `WARN:`. The line must
	// not become `WARN: WARN: …`. (Plain warnings still receive `WARN: `; this
	// test scopes the check to already-prefixed ones.)
	const { api } = createApi({ webSearchEnabled: false });
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	assert.doesNotMatch(result, /WARN: WARN: /);
	assert.match(result, /WARN: web_search disabled in settings/);
});

test("execute validate prefixes plain warnings with WARN:", async () => {
	// `createSettings` only configures 4 of MODEL_ROLES; every other role is
	// unconfigured and produces a plain `role X is not configured; …` line.
	// Such plain warnings must receive the legacy `WARN: ` prefix so the
	// transcript classifies them as warnings (the WARN/INFO/ERROR detector
	// only short-circuits when the prefix is already present).
	const { api } = createApi();
	const { ctx } = createContext();
	const target = modelRolesFactory(api as never);
	const result = await target.execute(["validate"], ctx as never);
	// Positive: at least one plain-warning line is prefixed.
	assert.match(result, /^WARN: role \S+ is not configured; using \S+ fallback/m);
	// Negative: the prefix must not be doubled.
	assert.doesNotMatch(result, /^WARN: WARN: role \S+ is not configured;/m);
});
