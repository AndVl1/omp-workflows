/**
 * Smoke test: the `/cto` custom-TS command must boot, parse the envelope,
 * render the team registry, and emit a fully-formed CTO prompt — without
 * importing OMP at all (fake CustomCommandAPI + HookCommandContext).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ctoFactory from "../commands/cto/index.js";
import { buildCtoPrompt, parseEnvelope } from "../commands/cto/_lib/cto.js";

const projectRoot = process.cwd();

const fakeApi = {
	cwd: projectRoot,
	exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	typebox: {} as never,
	arktype: {} as never,
	zod: {} as never,
	pi: {} as never,
};

const fakeCtx = {
	cwd: projectRoot,
	ui: { notify: () => undefined },
	hasUI: false,
	sessionManager: undefined,
	modelRegistry: undefined,
	model: undefined,
	isIdle: () => true,
	abort: () => undefined,
	hasQueuedMessages: () => false,
};

const TEAMS_JSON = [
	{
		id: "kotlin-backend",
		name: "Kotlin Backend",
		scope: ["backend-kotlin"],
		profile: "lightweight",
		lead: "team-lead",
		roster: ["backend-kotlin"],
	},
	{
		id: "frontend",
		name: "Frontend",
		scope: ["frontend"],
		profile: "lightweight",
		lead: "team-lead",
		roster: ["frontend"],
	},
];

test("fullstack: /cto command loads and parses an envelope", async () => {
	const cmd = ctoFactory(fakeApi as never);
	assert.equal(cmd.name, "cto");
	assert.ok(cmd.description.includes("CTO"));

	const result = await cmd.execute(["Add OAuth with Google"], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Add OAuth with Google"), "result echoes the task");
	assert.ok(result.includes("/cto workflow"), "result opens the CTO contract");
	assert.ok(result.includes("Team registry"), "prompt includes the team registry section");
	assert.ok(result.includes("CTO discipline"), "prompt includes the CTO discipline");
	assert.ok(result.includes("max 8"), "prompt states the team cap");
});

	test("fullstack: /cto renders teams from .omp/teams.json", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-"));
	try {
		mkdirSync(join(root, ".omp"), { recursive: true });
		writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify(TEAMS_JSON));
		const result = buildCtoPrompt(parseEnvelope("Add OAuth", root), root);
		assert.ok(result.includes("| `kotlin-backend` | Kotlin Backend |"), "backend team row rendered");
		assert.ok(result.includes("| `frontend` | Frontend |"), "frontend team row rendered");
		assert.ok(!result.includes("(no teams configured)"), "no fallback hint when teams exist");
		assert.ok(result.includes("Leads never write source"), "lead self-coding forbidden in the contract");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: /cto degrades gracefully without teams.json", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-empty-"));
	try {
		const result = buildCtoPrompt(parseEnvelope("Add OAuth", root), root);
		assert.ok(result.includes("(no teams configured)"), "fallback hint rendered");
		assert.ok(result.includes(".omp/teams.json"), "hint names the file to create");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fullstack: [AUTONOMOUS] prefix toggles autonomous mode", async () => {
	const cmd = ctoFactory(fakeApi as never);
	const result = await cmd.execute(["[AUTONOMOUS] Fix bug #42"], fakeCtx as never);
	assert.ok(result.includes("Autonomous mode: ON"), "autonomous flag lands in metadata");
});

test("fullstack: issue=#N is stripped into the prompt metadata", async () => {
	const cmd = ctoFactory(fakeApi as never);
	const result = await cmd.execute(["Add OAuth issue=#7"], fakeCtx as never);
	assert.ok(result.includes("Issue: #7"), "issue metadata rendered");
	assert.ok(!result.includes("issue=#7"), "raw issue token stripped from the task");
});

test("fullstack: usage hint on empty args", async () => {
	const cmd = ctoFactory(fakeApi as never);
	const result = await cmd.execute([], fakeCtx as never);
	assert.ok(result.includes("Usage: /cto"), "usage hint on empty args");
});

test("fullstack: parseEnvelope falls back to branch=null outside a git work tree", () => {
	const root = mkdtempSync(join(tmpdir(), "cto-cmd-nogit-"));
	try {
		const envelope = parseEnvelope("Add OAuth", root);
		assert.equal(envelope.branch, null);
		assert.equal(envelope.task, "Add OAuth");
		assert.equal(envelope.autonomous, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
