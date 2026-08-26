/**
 * INT-001 regression guard: the core default path carries no fullstack
 * domain defaults. Roles/scope_map/flags are neutral-empty unless supplied
 * by the project config or an explicit caller preset, scope classification
 * tables are caller data only, and `${scope.dev_agent}` fails closed with a
 * typed error instead of silently substituting `developer-kotlin`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/engine/config.js";
import { resolveScope, runtimeClassForScope } from "../src/engine/scope.js";
import { DevAgentUnavailableError, resolveStageDispatchSlots } from "../src/engine/stage.js";
import { writeConfig } from "../src/runtime-config.js";
import * as coreBarrel from "../src/index.js";

/** Domain vocabulary that must never reappear on the core default path. */
const DOMAIN_ROLE_NAMES = ["backend-kotlin", "go", "frontend", "mobile", "developer-kotlin", "developer-go", "frontend-developer", "developer-mobile"];
const DOMAIN_SCOPES = ["backend-kotlin", "go", "frontend", "mobile"];

function emptyWorkspace(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

test("core default path: barrel exports no domain defaults", () => {
	assert.equal("DEFAULT_ROLES" in coreBarrel, false);
	assert.equal("DEFAULT_SCOPE_MAP" in coreBarrel, false);
	assert.equal("DEFAULT_FLAGS" in coreBarrel, false);
	assert.equal("DEFAULT_SCOPE_RUNTIME_CLASSES" in coreBarrel, false);
});

test("resolveConfig without config or preset degrades to neutral empty values", () => {
	const root = emptyWorkspace("core-neutral-config-");
	try {
		const config = resolveConfig(root);
		assert.equal(config.config_source, "defaults");
		assert.deepEqual(config.roles, {});
		assert.deepEqual(config.scope_map, []);
		assert.deepEqual(config.flags, {});
		for (const role of Object.keys(config.roles)) {
			assert.ok(!DOMAIN_ROLE_NAMES.includes(role), `unexpected domain role '${role}' on the core default path`);
		}
		for (const entry of config.scope_map) {
			assert.ok(!DOMAIN_SCOPES.includes(entry.scope), `unexpected domain scope '${entry.scope}' on the core default path`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveConfig applies a caller-supplied preset only where the config omits keys", () => {
	const root = emptyWorkspace("core-preset-config-");
	mkdirSync(join(root, ".omp"), { recursive: true });
	try {
		writeConfig(join(root, ".omp", "team.config.json"), {
			roles: { custom: "custom-agent" },
		});
		const config = resolveConfig(root, {
			roles: { "backend-kotlin": "developer-kotlin" },
			scope_map: [{ glob: ["**/*.kt"], scope: "backend-kotlin", dev_agent: "developer-kotlin" }],
			flags: { has_security: ["**/auth/**"] },
		});
		assert.equal(config.roles["custom"], "custom-agent", "config document wins over preset for the same key");
		assert.equal(config.roles["backend-kotlin"], "developer-kotlin", "preset fills keys the config omits");
		assert.equal(config.scope_map.length, 1);
		assert.equal(config.scope_map[0].scope, "backend-kotlin");
		assert.deepEqual(config.flags.has_security, ["**/auth/**"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


test("scope classification is caller-supplied: no built-in domain tables remain", () => {
	assert.equal(runtimeClassForScope("backend-kotlin"), null);
	assert.equal(runtimeClassForScope("frontend"), null);

	const root = emptyWorkspace("core-scope-tables-");
	mkdirSync(join(root, ".omp"), { recursive: true });
	try {
		const configPath = join(root, ".omp", "team.config.json");
		writeConfig(configPath, {
			scope_map: [
				{ glob: ["**/*.tsx"], scope: "frontend", dev_agent: "frontend-developer" },
				{ glob: ["**/*.kt"], scope: "backend-kotlin", dev_agent: "developer-kotlin" },
				{ glob: ["**/*.md"], scope: "docs", dev_agent: "writer" },
			],
			scope_runtime_classes: { frontend: "runtime", "backend-kotlin": "runtime" },
			scope_ui_classes: { frontend: true },
		});
		const config = resolveConfig(root);
		const flags = resolveScope(["web/app.tsx"], config);
		assert.equal(flags.has_ui, true, "caller ui table marks the scope as UI");
		assert.equal(flags.has_runtime, true, "caller runtime table classifies the scope");
		assert.equal(flags.dev_agent, "frontend-developer");

		const backend = resolveScope(["src/main.kt"], config);
		assert.equal(backend.has_runtime, true);
		assert.equal(backend.has_ui, false);

		const docs = resolveScope(["guide/readme.md"], config);
		assert.equal(docs.has_runtime, false, "scopes outside caller tables classify to nothing");
		assert.equal(docs.has_ui, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const DEV_AGENT_STAGE = {
	id: "implementation",
	title: "Implementation",
	type: "single" as const,
	role: "${scope.dev_agent}",
};

test("${scope.dev_agent} fails closed with a typed error when the scope has no dev agent", () => {
	const ctx = {
		cwd: process.cwd(),
		flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
		resolveDevAgent: () => null as string | null,
	};
	assert.throws(
		() => resolveStageDispatchSlots(DEV_AGENT_STAGE, ctx),
		(error: unknown) => error instanceof DevAgentUnavailableError && error.message.includes("implementation"),
		"unresolved ${scope.dev_agent} must fail closed instead of substituting developer-kotlin",
	);
});

test("${scope.dev_agent} resolves when the caller supplies a matching scope", () => {
	const ctx = {
		cwd: process.cwd(),
		flags: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: "developer-go" },
		resolveDevAgent: () => "developer-go",
	};
	const slots = resolveStageDispatchSlots(DEV_AGENT_STAGE, ctx);
	assert.deepEqual(slots.map(slot => slot.role), ["developer-go"]);
});
