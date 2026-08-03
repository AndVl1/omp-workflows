/**
 * Smoke tests for `packages/core/src/model-roles.ts` — the bundle-agnostic
 * model-role taxonomy shared with downstream bundles.
 *
 * Verifies:
 *   1. The public exports resolve from the package barrel.
 *   2. `defaultFullstackModelRoles` is the same 14 entries fullstack ships today.
 *   3. `resolveRoleChain` returns class / fallback / none against a fixture inventory.
 *   4. `isResearchRequest` / `isResearchResponse` accept valid fixtures and reject
 *      malformed ones (type guard narrowing is exercised by the assert.equal call site).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	defaultFullstackModelRoles,
	isResearchRequest,
	isResearchResponse,
	resolveRoleChain,
	validateResearchRequest,
	validateResearchResponse,
	type BenchmarkSource,
	type InventoryModel,
	type ModelRoleEntry,
	type ResearchRecommendation,
	type ResearchRequest,
	type ResearchResponse,
	type RoleLookup,
} from "@andvl1/omp-workflows-core";

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

const fixedTimestamp = "2026-08-03T12:00:00.000Z";

test("core model-roles: defaultFullstackModelRoles exposes 14 entries", () => {
	assert.equal(defaultFullstackModelRoles.length, 14);
});

test("core model-roles: every entry has role/agents/standardFallback", () => {
	for (const entry of defaultFullstackModelRoles) {
		assert.equal(typeof entry.role, "string");
		assert.ok(Array.isArray(entry.agents) && entry.agents.length > 0);
		for (const agent of entry.agents) assert.equal(typeof agent, "string");
		assert.equal(typeof entry.standardFallback, "string");
		assert.ok(entry.standardFallback.startsWith("@"));
	}
});

test("core model-roles: resolveRoleChain returns class selector when configured", () => {
	const entry = { role: "example", agents: ["agent"], standardFallback: "@task" };
	const result = resolveRoleChain(entry, roleLookup({ example: "test/class-model", task: "test/fallback-model" }), inventory);
	assert.deepEqual(result, { status: "class", selector: "test/class-model" });
});

test("core model-roles: resolveRoleChain returns fallback when class role is missing", () => {
	const entry = { role: "example", agents: ["agent"], standardFallback: "@task" };
	const result = resolveRoleChain(entry, roleLookup({ task: "test/fallback-model" }), inventory);
	assert.deepEqual(result, { status: "fallback", selector: "test/fallback-model" });
});

test("core model-roles: resolveRoleChain returns none when nothing resolves", () => {
	const entry = { role: "example", agents: ["agent"], standardFallback: "@task" };
	const result = resolveRoleChain(entry, roleLookup({}), inventory);
	assert.deepEqual(result, { status: "none" });
});

test("core model-roles: isResearchRequest accepts a valid request and rejects garbage", () => {
	const request = {
		kind: "omp-model-role-research-request",
		schemaVersion: 1,
		requestedAt: fixedTimestamp,
		roles: defaultFullstackModelRoles,
		availableModels: inventory,
	};
	assert.equal(isResearchRequest(request), true);
	assert.equal(isResearchRequest({ kind: "something-else", schemaVersion: 1, requestedAt: fixedTimestamp, roles: [], availableModels: [] }), false);
	assert.equal(isResearchRequest(null), false);
	assert.equal(isResearchRequest("not-an-object"), false);
});

test("core model-roles: isResearchResponse accepts a valid response and rejects missing benchmark sources", () => {
	const validResponse = {
		kind: "omp-model-role-recommendations",
		schemaVersion: 1,
		generatedAt: fixedTimestamp,
		recommendations: [
			{
				role: "architect",
				modelSelector: "test/class-model",
				fit: "Strong",
				rationale: "Evidence-backed.",
				benchmarkSources: [
					{
						url: "https://example.com/benchmark",
						title: "Benchmark report",
						retrievedAt: fixedTimestamp,
						caveat: "Synthetic benchmark results.",
					},
				],
				confidence: "high",
			},
		],
		unavailableRoles: [{ role: "reviewer", reason: "No benchmark." }],
		warnings: ["Coverage limited."],
	};
	assert.equal(isResearchResponse(validResponse, inventory), true);
	assert.equal(
		isResearchResponse(
			{
				...validResponse,
				recommendations: [{ ...validResponse.recommendations[0], benchmarkSources: [] }],
			},
			inventory,
		),
		false,
	);
	assert.equal(isResearchResponse(null, inventory), false);
});

test("core model-roles: validateResearchRequest / validateResearchResponse are the type guards", () => {
	assert.equal(validateResearchRequest, isResearchRequest);
	assert.equal(validateResearchResponse, isResearchResponse);
});


test("core model-roles: isResearchRequest accepts InventoryModel with null contextWindow/maxTokens", () => {
	// Contract: InventoryModel.contextWindow and .maxTokens are `number | null`.
	// The validator must accept null alongside a finite number — otherwise
	// provider registries that omit these fields would be rejected.
	const inventoryWithNulls: InventoryModel[] = [
		{
			selector: "test/sparse-model",
			provider: "test",
			id: "sparse-model",
			name: "Sparse metadata model",
			contextWindow: null,
			maxTokens: null,
			reasoning: false,
		},
	];
	const request = {
		kind: "omp-model-role-research-request",
		schemaVersion: 1,
		requestedAt: fixedTimestamp,
		roles: defaultFullstackModelRoles,
		availableModels: inventoryWithNulls,
	};
	assert.equal(isResearchRequest(request), true);
	// Sanity: a non-null number still passes (positive parity with the legacy fixture).
	const requestWithNumbers = { ...request, availableModels: inventory };
	assert.equal(isResearchRequest(requestWithNumbers), true);
});

test("core model-roles: isResearchRequest rejects role entries with the wrong runtime types", () => {
	// Contract: each role must be { role: string; agents: string[]; standardFallback: string }
	// at runtime. The validator enforces the structural shape, not non-emptiness — so the
	// malformed cases are limited to type mismatches: non-string role, missing array, mixed-type
	// agents, non-string standardFallback. The happy-path test above covers the positive shape.
	const baseRequest = {
		kind: "omp-model-role-research-request",
		schemaVersion: 1,
		requestedAt: fixedTimestamp,
		availableModels: inventory,
	};
	// Non-string role.
	assert.equal(
		isResearchRequest({
			...baseRequest,
			roles: [{ role: 42 as unknown as string, agents: ["architect"], standardFallback: "@slow" }],
		}),
		false,
	);
	// agents is not an array.
	assert.equal(
		isResearchRequest({
			...baseRequest,
			roles: [{ role: "architect", agents: "architect" as unknown as string[], standardFallback: "@slow" }],
		}),
		false,
	);
	// agents contains a non-string.
	assert.equal(
		isResearchRequest({
			...baseRequest,
			roles: [{ role: "architect", agents: ["architect", 7 as unknown as string], standardFallback: "@slow" }],
		}),
		false,
	);
	// Non-string standardFallback.
	assert.equal(
		isResearchRequest({
			...baseRequest,
			roles: [{ role: "architect", agents: ["architect"], standardFallback: 0 as unknown as string }],
		}),
		false,
	);
	// role is not a record.
	assert.equal(
		isResearchRequest({
			...baseRequest,
			roles: [null as unknown as Record<string, unknown>],
		}),
		false,
	);
});

test("core model-roles: isResearchResponse accepts low/medium/high confidence and rejects unknown values", () => {
	// Contract: ResearchRecommendation.confidence is `'low' | 'medium' | 'high'`.
	// The validator only accepts these three values; any other string (including
	// close misspellings like 'super-high') must be rejected.
	const validSource: BenchmarkSource = {
		url: "https://example.com/benchmark",
		title: "Benchmark report",
		retrievedAt: fixedTimestamp,
		caveat: "Synthetic benchmark results.",
	};
	function makeResponse(confidence: ResearchRecommendation["confidence"]): ResearchResponse {
		return {
			kind: "omp-model-role-recommendations",
			schemaVersion: 1,
			generatedAt: fixedTimestamp,
			recommendations: [
				{
					role: "architect",
					modelSelector: "test/class-model",
					fit: "Strong",
					rationale: "Evidence-backed.",
					benchmarkSources: [validSource],
					confidence,
				},
			],
			unavailableRoles: [],
			warnings: [],
		};
	}
	for (const confidence of ["low", "medium", "high"] as const) {
		assert.equal(isResearchResponse(makeResponse(confidence), inventory), true, `confidence=${confidence} should be accepted`);
	}
	for (const confidence of ["super-high", "LOW", "", "unknown"]) {
		assert.equal(
			isResearchResponse(makeResponse(confidence as ResearchRecommendation["confidence"]), inventory),
			false,
			`confidence=${JSON.stringify(confidence)} should be rejected`,
		);
	}
});

test("core model-roles: second-bundle scenario compiles and runs against a fictional taxonomy", () => {
	// Contract (architecture.json api_contract.second_bundle_contract_minimal):
	// any bundle can define its own ModelRoleEntry[] array and reuse resolveRoleChain
	// + isResearchRequest + ModelRoleEntry verbatim — the core surface must be
	// bundle-agnostic. This test simulates a Rust-flavored bundle that ships its
	// own taxonomy and exercises the part of the contract that is bundle-agnostic.
	// NOTE: isResearchResponse checks recommendations against the fullstack role
	// allowlist (defaultFullstackModelRoles), so a Rust bundle cannot reuse it
	// without supplying its own allowlist — the second-bundle pattern is
	// documented as "reuses types + resolveRoleChain + isResearchRequest".
	const rustInventory: InventoryModel[] = [
		{
			selector: "rust/smol",
			provider: "rust",
			id: "smol",
			name: "Rust smol model",
			contextWindow: 32000,
			maxTokens: 4096,
			reasoning: false,
		},
		{
			selector: "rust/slow",
			provider: "rust",
			id: "slow",
			name: "Rust slow model",
			contextWindow: 128000,
			maxTokens: 8192,
			reasoning: true,
		},
	];
	const RUST_MODEL_ROLES: ModelRoleEntry[] = [
		{ role: "rust-architect", agents: ["architect"], standardFallback: "@slow" },
		{ role: "rust-reviewer", agents: ["code-reviewer"], standardFallback: "@slow" },
		{ role: "rust-developer", agents: ["developer-rust"], standardFallback: "@smol" },
	];
	// ROLE_COUNT = RUST_MODEL_ROLES.length (per architecture.json usage_pattern).
	assert.equal(RUST_MODEL_ROLES.length, 3);
	const rustLookup: RoleLookup = {
		getModelRole: role => (role === "rust-architect" ? "rust/slow" : role === "slow" ? "rust/slow" : role === "smol" ? "rust/smol" : undefined),
	};
	// resolveRoleChain resolves a class-role selector from a fictional inventory.
	const classResolution = resolveRoleChain(RUST_MODEL_ROLES[0]!, rustLookup, rustInventory);
	assert.deepEqual(classResolution, { status: "class", selector: "rust/slow" });
	// resolveRoleChain falls back when the class role is unconfigured but the standard-fallback is.
	const noClassLookup: RoleLookup = { getModelRole: role => (role === "slow" ? "rust/slow" : undefined) };
	const fallbackResolution = resolveRoleChain(RUST_MODEL_ROLES[1]!, noClassLookup, rustInventory);
	assert.deepEqual(fallbackResolution, { status: "fallback", selector: "rust/slow" });
	// resolveRoleChain returns `none` for a fully unconfigured bundle role.
	const emptyLookup: RoleLookup = { getModelRole: () => undefined };
	const noneResolution = resolveRoleChain(RUST_MODEL_ROLES[2]!, emptyLookup, rustInventory);
	assert.deepEqual(noneResolution, { status: "none" });
	// The fictional taxonomy flows through isResearchRequest unchanged (the request
	// validator is purely structural and does not pin to defaultFullstackModelRoles).
	const rustRequest: ResearchRequest = {
		kind: "omp-model-role-research-request",
		schemaVersion: 1,
		requestedAt: fixedTimestamp,
		roles: RUST_MODEL_ROLES,
		availableModels: rustInventory,
	};
	assert.equal(isResearchRequest(rustRequest), true);
	// The structural RoleResolution type narrows correctly: status is a literal union,
	// not an arbitrary string. This is the contract downstream callers rely on for
	// typed switch statements. (Compile-time guarantee, exercised here for documentation.)
	const typedResolution: RoleResolution = classResolution;
	assert.equal(typedResolution.status, "class");
	assert.equal(typedResolution.selector, "rust/slow");
});