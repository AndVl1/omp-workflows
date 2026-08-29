import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ALLOWED_POOL_AGENTS } from "../src/pool.js";
import { loadOmpWorkflowProfiles } from "../src/profiles.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("agents directory contains exactly the allowed omp-* pool", () => {
	const files = readdirSync(join(packageRoot, "agents")).filter((name) => name.endsWith(".md"));
	const expected = [...ALLOWED_POOL_AGENTS].sort();
	assert.deepEqual(
		files.map((name) => name.replace(/\.md$/, "")).sort(),
		expected,
	);
	for (const file of files) {
		assert.ok(file.startsWith("omp-"), `agent asset must be hyphen-prefixed: ${file}`);
	}
});

test("no bare or reserved command/agent names leak into assets", () => {
	const reserved = ["do-work", "team", "cto", "omp-model-roles"];
	for (const name of ALLOWED_POOL_AGENTS) {
		for (const bare of ["do-work", "team", "cto"]) {
			assert.notEqual(name, bare);
		}
		assert.notEqual(name, "omp-model-roles");
		assert.ok(!reserved.includes(name));
	}
});

test("agent files declare the full frontmatter and stay concise", () => {
	for (const agent of ALLOWED_POOL_AGENTS) {
		const raw = readFileSync(join(packageRoot, "agents", `${agent}.md`), "utf8");
		const frontmatter = raw.split("---")[1] ?? "";
		assert.ok(frontmatter.includes(`name: ${agent}\n`), `${agent}: missing name`);
		for (const key of ["model:", "thinkingLevel:", "description:", "tools:"]) {
			assert.ok(frontmatter.includes(key), `${agent}: missing frontmatter key ${key}`);
		}
		const lineCount = raw.split("\n").length;
		assert.ok(lineCount < 60, `${agent}: expected <60 lines, got ${lineCount}`);
	}
});

test("bundle profiles load, validate and use only the allowed pool roles", () => {
	const profiles = loadOmpWorkflowProfiles();
	assert.deepEqual(profiles.map((profile) => profile.name), ["omp-feature", "omp-validate"]);
	const roleKeys = new Set(Object.keys({
		"team-lead": "",
		analyst: "",
		"tech-researcher": "",
		diagnostics: "",
		architect: "",
		developer: "",
		qa: "",
		"manual-qa": "",
		"code-reviewer": "",
		"security-tester": "",
		devops: "",
		"plugin-developer": "",
		"host-integration": "",
		"package-release": "",
	}));
	for (const profile of profiles) {
		for (const stage of profile.stages) {
			if ("role" in stage && typeof stage.role === "string" && !stage.role.startsWith("${")) {
				assert.ok(roleKeys.has(stage.role), `${profile.name}/${stage.id}: unknown role '${stage.role}'`);
			}
			if ("roles" in stage && Array.isArray(stage.roles)) {
				for (const role of stage.roles) {
					assert.ok(roleKeys.has(role), `${profile.name}/${stage.id}: unknown role '${role}'`);
				}
			}
			if ("conditional" in stage && Array.isArray(stage.conditional)) {
				for (const entry of stage.conditional) {
					if (entry && typeof entry === "object" && "add" in entry) {
						assert.ok(roleKeys.has(String(entry.add)), `${profile.name}/${stage.id}: unknown conditional role '${String(entry.add)}'`);
					}
				}
			}
		}
	}
});

test("profiles are named omp-* only", () => {
	for (const profile of loadOmpWorkflowProfiles()) {
		assert.match(profile.name, /^omp-[a-z-]+$/);
	}
});
