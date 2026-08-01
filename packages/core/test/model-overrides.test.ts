/**
 * Tests for the model-overrides module.
 *
 * Covers:
 *   - schema.validateModelsJson: parse + filter unknown roles (happy path + invalid)
 *   - command.runModelOverrides: end-to-end against an in-memory FS
 *     (happy path: models.json missing + preset → wrote; idempotent re-run → skipped;
 *      source priority: project .omp/agents/<role>.md wins over bundled)
 *   - command.patchAgentFrontmatter: replace existing / insert new
 *
 * Tests use an in-memory FsAdapter so they do not touch the host filesystem.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	CORE_OVERRIDABLE_ROLES,
	ModelsJsonError,
	patchAgentFrontmatter,
	runModelOverrides,
	validateModelsJson,
	type FsAdapter,
	type ModelEntry,
} from "../src/model-overrides/index.js";

const SILENT = { warn: () => {} };

function makeFs(initial: Record<string, string> = {}): FsAdapter & { read_all(): Record<string, string> } {
	const files = new Map<string,string>(Object.entries(initial));
	return {
		exists: (p) => files.has(p),
		read: (p) => {
			const v = files.get(p);
			if (v === undefined) throw new Error(`ENOENT: ${p}`);
			return v;
		},
		write: (p, c) => { files.set(p, c); },
		mkdirp: () => {},
		read_all: () => Object.fromEntries(files),
	};
}

const SAMPLE_SOURCE = `---
name: architect
description: Architect agent
model: "@slow"
---

# Architect body

This is the body.
`;

test("schema: validateModelsJson accepts a well-formed input", () => {
	const raw = {
		schema_version: 1,
		models: [
			{ id: "minimax-m3", label: "M3", provider: "minimax", model_id: "MiniMax/M3" },
		],
		overrides: {
			architect: { model_id: "MiniMax/M3", agent_slug: "architect-minimax" },
		},
	};
	const out = validateModelsJson(raw, SILENT);
	assert.equal(out.schema_version, 1);
	assert.equal(out.models.length, 1);
	assert.equal(out.models[0]?.id, "minimax-m3");
	assert.equal(out.overrides.architect?.agent_slug, "architect-minimax");
});

test("schema: validateModelsJson filters unknown roles with a warn callback", () => {
	const warns: string[] = [];
	const raw = {
		schema_version: 1,
		models: [],
		overrides: {
			architect: { model_id: "x", agent_slug: "x" },
			"security-tester": { model_id: "y", agent_slug: "y" },
			"manual-qa": { model_id: "z", agent_slug: "z" },
		},
	};
	const out = validateModelsJson(raw, { warn: (m) => warns.push(m) });
	assert.ok(out.overrides.architect);
	assert.equal(out.overrides["security-tester"], undefined);
	assert.equal(out.overrides["manual-qa"], undefined);
	assert.equal(warns.length, 2);
	assert.ok(warns[0]?.includes("security-tester"));
	assert.ok(warns[1]?.includes("manual-qa"));
});

test("schema: validateModelsJson throws ModelsJsonError on missing required field", () => {
	const raw = {
		schema_version: 1,
		models: [{ id: "x", label: "L", provider: "p" /* missing model_id */ }],
		overrides: {},
	};
	assert.throws(() => validateModelsJson(raw, SILENT), (e: unknown) => {
		return e instanceof ModelsJsonError && e.message.includes("model_id");
	});
});

test("schema: validateModelsJson throws on wrong schema_version", () => {
	const raw = { schema_version: 2, models: [], overrides: {} };
	assert.throws(() => validateModelsJson(raw, SILENT), /schema_version/);
});

test("schema: validateModelsJson throws on non-object root", () => {
	assert.throws(() => validateModelsJson("not an object", SILENT), /object/);
	assert.throws(() => validateModelsJson(null, SILENT), /object/);
	assert.throws(() => validateModelsJson([], SILENT), /object/);
});

test("schema: validateModelsJson throws when model has empty id", () => {
	const raw = {
		schema_version: 1,
		models: [{ id: "", label: "L", provider: "p", model_id: "m" }],
		overrides: {},
	};
	assert.throws(() => validateModelsJson(raw, SILENT), /id must be a non-empty string/);
});

test("schema: validateModelsJson requires overrides to be an object", () => {
	const raw = { schema_version: 1, models: [], overrides: "not an object" };
	assert.throws(() => validateModelsJson(raw, SILENT), /overrides.*must be an object/);
});

test("command: runModelOverrides is noop when models.json missing and no force/preset", () => {
	const fs = makeFs();
	const res = runModelOverrides({ cwd: "/proj", fs });
	assert.equal(res.status, "noop");
	assert.equal(res.agentsWritten.length, 0);
});

test("command: runModelOverrides with preset writes models.json + agent .md + .source-hash", () => {
	const fs = makeFs({
		"/proj/.omp/agents/architect.md": SAMPLE_SOURCE,
	});
	const res = runModelOverrides({
		cwd: "/proj",
		fs,
		presetOverrides: {
			architect: { model_id: "deepseek-flash", agent_slug: "architect-deepseek-flash" },
		},
	});
	assert.equal(res.status, "wrote");

	const all = fs.read_all();
	const mj = JSON.parse(all["/proj/.omp/models.json"]!);
	assert.equal(mj.schema_version, 1);
	assert.deepEqual(mj.overrides.architect, {
		model_id: "deepseek-flash",
		agent_slug: "architect-deepseek-flash",
	});

	const agent = all["/proj/.omp/agents/architect-deepseek-flash/architect-deepseek-flash.md"];
	assert.ok(agent, "agent .md was written");
	assert.match(agent!, /^---\n/);
	assert.match(agent!, /^name: architect-deepseek-flash$/m);
	assert.match(agent!, /^model: deepseek-flash$/m);
	assert.ok(agent!.includes("# Architect body"));

	const hash = all["/proj/.omp/agents/architect-deepseek-flash/.source-hash"];
	assert.ok(hash, ".source-hash was written");
	assert.match(hash!.trim(), /^[a-f0-9]{64}$/);
});

test("command: idempotent re-run skips agents whose hash is unchanged", () => {
	const fs = makeFs({
		"/proj/.omp/agents/architect.md": SAMPLE_SOURCE,
		"/proj/.omp/models.json": JSON.stringify({
			schema_version: 1,
			models: [],
			overrides: {
				architect: { model_id: "deepseek-flash", agent_slug: "architect-deepseek-flash" },
			},
		}),
	});
	const first = runModelOverrides({ cwd: "/proj", fs });
	assert.equal(first.status, "wrote");
	assert.equal(first.agentsWritten.length, 1);

	const second = runModelOverrides({ cwd: "/proj", fs });
	assert.equal(second.status, "wrote");
	assert.equal(second.agentsWritten.length, 0);
	assert.equal(second.agentsSkipped.length, 1);
	assert.match(second.agentsSkipped[0]!.reason, /up-to-date/);
});

test("command: re-runs when source agent .md changes (hash invalidation)", () => {
	const fs = makeFs({
		"/proj/.omp/agents/architect.md": SAMPLE_SOURCE,
		"/proj/.omp/models.json": JSON.stringify({
			schema_version: 1,
			models: [],
			overrides: {
				architect: { model_id: "deepseek-flash", agent_slug: "architect-deepseek-flash" },
			},
		}),
	});
	const first = runModelOverrides({ cwd: "/proj", fs });
	assert.equal(first.agentsWritten.length, 1);

	// Source agent content changes — generated .md should be regenerated.
	fs.write("/proj/.omp/agents/architect.md", SAMPLE_SOURCE + "\nMore content.\n");
	const second = runModelOverrides({ cwd: "/proj", fs });
	assert.equal(second.agentsWritten.length, 1, "regenerated after source drift");
	assert.equal(second.agentsSkipped.length, 0);
});

test("command: project-level .omp/agents/<role>.md wins over bundled", () => {
	const fs = makeFs({
		"/proj/.omp/agents/architect.md": "---\nname: project-architect\nmodel: custom\n---\n\nPROJECT BODY",
		"/proj/.omp/models.json": JSON.stringify({
			schema_version: 1,
			models: [],
			overrides: {
				architect: { model_id: "m", agent_slug: "architect-m" },
			},
		}),
	});
	const res = runModelOverrides({
		cwd: "/proj",
		fs,
		bundledAgentsDir: "/bundled",
	});
	assert.equal(res.status, "wrote");
	const generated = fs.read_all()["/proj/.omp/agents/architect-m/architect-m.md"];
	assert.ok(generated);
	assert.match(generated!, /PROJECT BODY/);
});

test("command: skips override gracefully when no source agent found anywhere", () => {
	const fs = makeFs({
		"/proj/.omp/models.json": JSON.stringify({
			schema_version: 1,
			models: [],
			overrides: {
				architect: { model_id: "m", agent_slug: "architect-m" },
			},
		}),
	});
	const res = runModelOverrides({
		cwd: "/proj",
		fs,
		bundledAgentsDir: "/nonexistent-bundled",
	});
	assert.equal(res.status, "wrote");
	assert.equal(res.agentsWritten.length, 0);
	assert.equal(res.agentsSkipped.length, 1);
	assert.match(res.agentsSkipped[0]!.reason, /no source agent/);
});

test("command: returns 'failed' when existing models.json is malformed", () => {
	const fs = makeFs({
		"/proj/.omp/models.json": "{not json",
	});
	const res = runModelOverrides({ cwd: "/proj", fs });
	assert.equal(res.status, "failed");
	assert.match(res.message, /\.omp\/models\.json/);
});

test("command: empty overrides map writes models.json but no agent files", () => {
	const fs = makeFs();
	const res = runModelOverrides({
		cwd: "/proj",
		fs,
		force: true,
		presetOverrides: {},
	});
	assert.equal(res.status, "wrote");
	assert.equal(res.agentsWritten.length, 0);
	const all = fs.read_all();
	assert.ok(all["/proj/.omp/models.json"], "models.json still written for force-init");
});

test("command: force=true initialises models.json with default models", () => {
	const fs = makeFs();
	const res = runModelOverrides({ cwd: "/proj", fs, force: true });
	assert.equal(res.status, "wrote");
	const mj = JSON.parse(fs.read_all()["/proj/.omp/models.json"]!);
	assert.equal(mj.schema_version, 1);
	assert.ok(Array.isArray(mj.models));
	assert.ok(mj.models.length > 0, "default models included");
});

test("command: only roles in CORE_OVERRIDABLE_ROLES get processed", () => {
	const fs = makeFs();
	// .omp/agents/architect.md exists; .omp/agents/security-tester.md does not.
	fs.write("/proj/.omp/agents/architect.md", SAMPLE_SOURCE);
	fs.write("/proj/.omp/models.json", JSON.stringify({
		schema_version: 1,
		models: [],
		overrides: {
			architect: { model_id: "m", agent_slug: "architect-m" },
			"security-tester": { model_id: "m", agent_slug: "security-tester-m" },
		},
	}));
	const res = runModelOverrides({ cwd: "/proj", fs, bundledAgentsDir: "/nonexistent" });
	assert.equal(res.agentsWritten.length, 1);
	assert.equal(res.agentsWritten[0]!.role, "architect");
});

test("patchAgentFrontmatter: replaces existing name and model fields", () => {
	const out = patchAgentFrontmatter(SAMPLE_SOURCE, "architect-m", "MiniMax/M3");
	assert.match(out, /^name: architect-m$/m);
	assert.match(out, /^model: MiniMax\/M3$/m);
	assert.ok(out.includes("# Architect body"));
});

test("patchAgentFrontmatter: prepends frontmatter when source has none", () => {
	const out = patchAgentFrontmatter("# Plain body\n", "x", "y");
	assert.match(out, /^---\nname: x\nmodel: y\n---\n\n# Plain body/);
});

test("CORE_OVERRIDABLE_ROLES contains exactly the five agreed roles", () => {
	assert.deepEqual([...CORE_OVERRIDABLE_ROLES], [
		"architect", "analyst", "code-reviewer", "developer", "qa",
	]);
});
test("schema: rejects agent_slug with path separators (F1 hardening)", () => {
	const raw = {
		schema_version: 1,
		models: [{ id: "x", label: "L", provider: "p", model_id: "m" }],
		overrides: {
			architect: { model_id: "m", agent_slug: "../../evil" },
		},
	};
	assert.throws(() => validateModelsJson(raw, SILENT), (e: unknown) => {
		return e instanceof ModelsJsonError && e.message.includes("agent_slug");
	});
});

test("schema: rejects model id with path separators", () => {
	const raw = {
		schema_version: 1,
		models: [{ id: "../etc/passwd", label: "L", provider: "p", model_id: "m" }],
		overrides: {},
	};
	assert.throws(() => validateModelsJson(raw, SILENT), /id/);
});

test("schema: rejects unknown model fields (F3 hardening)", () => {
	const raw = {
		schema_version: 1,
		models: [{ id: "x", label: "L", provider: "p", model_id: "m", modelId: "typo" }],
		overrides: {},
	};
	assert.throws(() => validateModelsJson(raw, SILENT), (e: unknown) => {
	return e instanceof ModelsJsonError && e.message.includes("unknown field");
	});
});

test("schema: rejects unknown override fields", () => {
	const raw = {
		schema_version: 1,
		models: [],
		overrides: {
			architect: { model_id: "m", agent_slug: "ok", modelId: "typo" },
		},
	};
	assert.throws(() => validateModelsJson(raw, SILENT), /unknown field/);
});

test("command: does not write models.json when content is unchanged (F2 hardening)", () => {
	const fs = makeFs({
		"/proj/.omp/agents/architect.md": SAMPLE_SOURCE,
	});
	// First run writes models.json
	runModelOverrides({
		cwd: "/proj",
		fs,
		presetOverrides: {
			architect: { model_id: "deepseek-flash", agent_slug: "architect-deepseek-flash" },
		},
	});
	const before = fs.read_all()["/proj/.omp/models.json"];
	// Second run with same inputs should not change models.json
	runModelOverrides({ cwd: "/proj", fs });
	const after = fs.read_all()["/proj/.omp/models.json"];
	assert.equal(before, after);
});

test("patchAgentFrontmatter: handles source with leading BOM (F5 hardening)", () => {
	const source = "\uFEFF---\nname: architect\nmodel: \"@slow\"\n---\n\n# Body\n";
	const out = patchAgentFrontmatter(source, "architect-bom", "MiniMax/M3");
	assert.match(out, /^name: architect-bom$/m);
	assert.match(out, /^model: MiniMax\/M3$/m);
	assert.ok(out.includes("# Body"));
	// Sanity: no duplicate frontmatter block
	const fmCount = (out.match(/^---$/mg) ?? []).length;
	assert.equal(fmCount, 2, "exactly one frontmatter block (open + close)");
});

test("default models include minimax-m3 and deepseek-flash", async () => {
});
