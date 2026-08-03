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
	type InventoryModel,
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