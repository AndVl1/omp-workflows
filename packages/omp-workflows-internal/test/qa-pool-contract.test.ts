import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { applyConditional, resolveScope } from "@andvl1/omp-workflows-core";

import {
	ALLOWED_POOL_AGENTS,
	defaultOmpInternalFlags,
	defaultOmpInternalRoles,
	defaultOmpInternalScopeMap,
} from "../src/pool.js";
import { loadOmpWorkflowProfiles } from "../src/profiles.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Domain-writer agent symbols from the generic/fullstack taxonomy. None of
 * them may appear anywhere in this bundle's composition surface (matrix:
 * "no Rust/domain writers"). Symbol-level names, so prose mentions of e.g.
 * "TypeScript" cannot false-positive.
 */
const FORBIDDEN_WRITER_SYMBOLS = [
	"developer-kotlin",
	"developer-go",
	"developer-mobile",
	"developer-rust",
	"frontend-developer",
	"backend-kotlin",
	"backend-rust",
	"go-developer",
	"rust-developer",
] as const;

/** Core-known scope-flag names usable in `conditional.if` expressions. */
const KNOWN_SCOPE_FLAGS = ["has_security", "has_infra", "has_ui", "has_runtime"] as const;

function bundleConfigText(): string {
	return JSON.stringify({
		roles: defaultOmpInternalRoles,
		scope_map: defaultOmpInternalScopeMap,
		flags: defaultOmpInternalFlags,
	});
}

test("every workflow role resolves into the allowed pool, one agent per role", () => {
	const pool = new Set(ALLOWED_POOL_AGENTS);
	for (const [role, agent] of Object.entries(defaultOmpInternalRoles)) {
		assert.equal(typeof agent, "string", `role '${role}' must map to a single agent string`);
		assert.ok(agent.length > 0, `role '${role}' must not map to an empty agent`);
		assert.ok(pool.has(agent), `role '${role}' maps to '${agent}' which is outside the allowed pool`);
	}
});

test("role keys cover every role referenced by the shipped profiles", () => {
	const roleKeys = new Set(Object.keys(defaultOmpInternalRoles));
	for (const profile of loadOmpWorkflowProfiles()) {
		for (const stage of profile.stages) {
			if ("role" in stage && typeof stage.role === "string" && !stage.role.startsWith("${")) {
				assert.ok(roleKeys.has(stage.role), `${profile.name}/${stage.id}: role '${stage.role}' has no mapping`);
			}
			if ("roles" in stage && Array.isArray(stage.roles)) {
				for (const role of stage.roles) {
					assert.ok(roleKeys.has(role), `${profile.name}/${stage.id}: role '${role}' has no mapping`);
				}
			}
			if ("conditional" in stage && Array.isArray(stage.conditional)) {
				for (const entry of stage.conditional) {
					if (entry && typeof entry === "object" && "add" in entry) {
						assert.ok(
							roleKeys.has(String(entry.add)),
							`${profile.name}/${stage.id}: conditional role '${String(entry.add)}' has no mapping`,
						);
					}
				}
			}
		}
	}
});

test("consilium rosters carry no duplicate roles and single stages dispatch exactly one worker", () => {
	for (const profile of loadOmpWorkflowProfiles()) {
		for (const stage of profile.stages) {
			if (stage.type === "consilium") {
				const roles = ("roles" in stage && Array.isArray(stage.roles) ? stage.roles : []) as string[];
				assert.ok(roles.length > 0, `${profile.name}/${stage.id}: consilium needs a base roster`);
				assert.equal(new Set(roles).size, roles.length, `${profile.name}/${stage.id}: duplicate roster roles`);
			}
			if (stage.type === "single") {
				const roles = ("roles" in stage && Array.isArray(stage.roles) ? stage.roles : []) as string[];
				assert.ok(!("roles" in stage) || roles.length <= 1, `${profile.name}/${stage.id}: single stage must not fan out`);
			}
		}
	}
});

test("conditional triggers reference known scope flags; shipped flags define all but the documented exception", () => {
	const referenced = new Set<string>();
	for (const profile of loadOmpWorkflowProfiles()) {
		for (const stage of profile.stages) {
			if (!("conditional" in stage) || !Array.isArray(stage.conditional)) continue;
			for (const rule of stage.conditional) {
				const match = /^(!?)(?:scope\.)?(has_\w+)$/.exec(String(rule?.if ?? ""));
				if (!match) continue;
				const flag = match[2] ?? "";
				assert.ok(
					(KNOWN_SCOPE_FLAGS as readonly string[]).includes(flag),
					`${profile.name}/${stage.id}: unknown scope flag '${flag}'`,
				);
				referenced.add(flag);
			}
		}
	}
	// Finding F1 (resolved): omp-validate.json no longer references
	// scope.has_ui — the rule was dropped because nothing under this bundle
	// can set has_ui (no UI scope class exists here). Every referenced flag
	// must therefore be defined by defaultOmpInternalFlags (has_runtime stays
	// exempt: core derives it from runtime classes).
	const undefinedButReferenced = [...referenced].filter(
		(flag) => !(flag in defaultOmpInternalFlags) && flag !== "has_runtime",
	);
	assert.deepEqual(undefinedButReferenced.sort(), []);
	assert.ok("has_security" in defaultOmpInternalFlags);
	assert.ok("has_infra" in defaultOmpInternalFlags);
});
test("conditional devops joins only when infra evidence exists, per policy", () => {
	const baseRoster = ["code-reviewer", "qa"];
	const featureReview = loadOmpWorkflowProfiles()
		.find((profile) => profile.name === "omp-feature")
		?.stages.find((stage) => stage.id === "code_review");
	assert.ok(featureReview, "omp-feature/code_review stage must exist");
	const conditional = ("conditional" in featureReview ? featureReview.conditional : undefined) as
		| Array<{ if: string; add?: string }>
		| undefined;
	assert.ok(Array.isArray(conditional) && conditional.length > 0, "review stage declares conditional joiners");

	const plain = resolveScope(["packages/core/src/engine/run.ts", "README.md"], {
		roles: defaultOmpInternalRoles,
		roster_overrides: {},
		scope_map: defaultOmpInternalScopeMap,
		flags: defaultOmpInternalFlags,
		design_system: null,
	});
	assert.equal(plain.has_infra, false, "plain TS sources must not trip has_infra");
	// Finding F2 (frozen lead decision): TS now classifies into the dev scope,
	// so dev_agent resolves in-pool instead of staying null (which would let
	// core fall back to its hardcoded 'developer-kotlin').
	assert.equal(plain.dev_agent, "omp-engine-specialist", "TS sources resolve dev_agent to the bundle generalist");
	let roster = applyConditional(baseRoster, conditional, plain);

	const infra = resolveScope(["Dockerfile", ".github/workflows/ci.yml"], {
		roles: defaultOmpInternalRoles,
		roster_overrides: {},
		scope_map: defaultOmpInternalScopeMap,
		flags: defaultOmpInternalFlags,
		design_system: null,
	});
	assert.equal(infra.has_infra, true, "infra globs must trip has_infra");
	roster = applyConditional(baseRoster, conditional, infra);
	assert.ok(roster.includes("devops"), "devops joins when has_infra fires");
});

test("security joiner fires only on security-scoped paths", () => {
	const conditional = [{ if: "scope.has_security", add: "security-tester" }];
	const config = {
		roles: defaultOmpInternalRoles,
		roster_overrides: {},
		scope_map: defaultOmpInternalScopeMap,
		flags: defaultOmpInternalFlags,
		design_system: null,
	};
	const clean = applyConditional(["qa"], conditional, resolveScope(["src/pool.ts"], config));
	assert.deepEqual(clean, ["qa"]);
	const flagged = applyConditional(["qa"], conditional, resolveScope(["src/auth/token.ts"], config));
	assert.deepEqual(flagged.sort(), ["qa", "security-tester"]);
});

test("no Rust/domain writer symbols leak into pool, scope map, profiles or agent assets", () => {
	const surfaces: Array<[string, string]> = [
		["pool taxonomy (roles/scope_map/flags)", bundleConfigText()],
		["workflows/omp-feature.json", readFileSync(join(packageRoot, "workflows", "omp-feature.json"), "utf8")],
		["workflows/omp-validate.json", readFileSync(join(packageRoot, "workflows", "omp-validate.json"), "utf8")],
	];
	for (const file of readdirSync(join(packageRoot, "agents"))) {
		surfaces.push([`agents/${file} (name)`, file]);
	}
	for (const [surface, text] of surfaces) {
		for (const symbol of FORBIDDEN_WRITER_SYMBOLS) {
			assert.ok(!text.includes(symbol), `${surface} must not reference domain writer '${symbol}'`);
		}
	}
});

test("for ANY input (including empty), every profile role expands into the allowed pool", () => {
	const pool = new Set(ALLOWED_POOL_AGENTS);
	const bundleConfig = {
		roles: defaultOmpInternalRoles,
		scope_map: defaultOmpInternalScopeMap,
		flags: defaultOmpInternalFlags,
	};
	// Empty set included on purpose: core resolves dev_agent to null there and
	// would fall back to its hardcoded 'developer-kotlin' (outside our write
	// scope) — so the profiles must not reference ${scope.dev_agent} at all.
	const inputs: string[][] = [
		[],
		["src/index.ts"],
		["packages/core/src/index.ts", "packages/fullstack/src/index.ts"],
		["package.json"],
		["Dockerfile", ".github/workflows/ci.yaml"],
		["packages/core/src/auth/token.ts", "helm/chart.yaml", "README.md"],
	];

	// Guard: no shipped stage may depend on the ${scope.dev_agent} placeholder.
	for (const profile of loadOmpWorkflowProfiles()) {
		for (const stage of profile.stages) {
			if ("role" in stage && typeof stage.role === "string") {
				assert.ok(!stage.role.startsWith("${"), `${profile.name}/${stage.id}: scope-dependent placeholder must not ship`);
			}
		}
	}
	// Frozen-decision check: whenever files DO classify, dev_agent stays in-pool.
	assert.equal(resolveScope(["packages/core/src/index.ts"], bundleConfig).dev_agent, "omp-engine-specialist");
	assert.equal(resolveScope([], bundleConfig).dev_agent, null);

	for (const files of inputs) {
		const flags = resolveScope(files, bundleConfig);
		for (const profile of loadOmpWorkflowProfiles()) {
			for (const stage of profile.stages) {
				const baseRoster =
					"role" in stage && typeof stage.role === "string"
						? [stage.role]
						: (("roles" in stage && Array.isArray(stage.roles) ? stage.roles : []) as string[]);
				const conditioned = applyConditional(baseRoster, stage.conditional as never, flags);
				for (const role of conditioned) {
					const agent = defaultOmpInternalRoles[role];
					assert.ok(agent, `${profile.name}/${stage.id}: role '${role}' has no mapping`);
					assert.ok(pool.has(agent), `input [${files.join(",")}] -> ${profile.name}/${stage.id} role '${role}' maps to '${agent}' outside the allowed pool`);
				}
			}
		}
	}
});
