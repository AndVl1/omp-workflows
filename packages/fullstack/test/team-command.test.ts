/**
 * Smoke tests for the `/do-work` custom-TS command. The command must hand
 * semantic classification to the main LLM before any workflow is selected.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import doWorkFactory, { buildPrompt, parseEnvelope } from "../commands/do-work/index.js";
import teamAliasFactory from "../commands/team/index.js";

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

test("fullstack: /do-work command loads and parses an envelope", async () => {
	const cmd = doWorkFactory(fakeApi as never);
	assert.equal(cmd.name, "do-work");
	assert.ok(cmd.description.length > 0);
});
test("fullstack: /do-work defers workflow selection to semantic classification", async () => {
	const cmd = doWorkFactory(fakeApi as never);
	const result = await cmd.execute(["Research how LLM agents are configured for app testing"], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Research how LLM agents are configured for app testing"));
	assert.ok(result.includes("classification pass"));
	assert.ok(result.includes("Do NOT use keyword counts"));
	assert.ok(result.includes("INVESTIGATION"));
	assert.ok(result.includes("Do NOT call `task` during classification"));
	assert.ok(!result.includes("Workflow: `full-feature`"), "no eager heuristic workflow is emitted");
	assert.ok(!result.includes("Stages (skeleton"), "profile stages are not exposed before classification");
});

test("fullstack: /team alias delegates to deferred /do-work prompt", async () => {
	const cmd = teamAliasFactory(fakeApi as never);
	const result = await cmd.execute(["Refactor auth middleware"], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Refactor auth middleware"));
	assert.ok(result.includes("classification pass"));
});


test("fullstack: [AUTONOMOUS] prefix toggles autonomous mode", async () => {
	const cmd = doWorkFactory(fakeApi as never);
	const result = await cmd.execute(["[AUTONOMOUS] Fix bug #42"], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Autonomous mode: ON"), "AUTONOMOUS prefix flips mode on");
	assert.ok(result.includes("Fix bug #42"));
});

test("fullstack: issue=#N is stripped into the prompt metadata", async () => {
	const cmd = doWorkFactory(fakeApi as never);
	const result = await cmd.execute(["Investigate regression issue=#1337"], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Issue: #1337"), "issue=#N is captured in the metadata block");
	assert.ok(!result.includes("issue=#1337"), "issue=#N is removed from the task body");
	assert.ok(result.includes("Investigate regression"));
});

test("fullstack: usage hint on empty args", async () => {
	const cmd = doWorkFactory(fakeApi as never);
	const result = await cmd.execute([], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Usage: /do-work"));
	assert.ok(result.includes("Alias: `/team`"), "usage surfaces the alias");
});

test("fullstack: parseEnvelope falls back to branch=null outside a git work tree", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-no-git-"));
	try {
		const envelope = parseEnvelope("Add small CLI flag", dir);
		assert.equal(envelope.task, "Add small CLI flag");
		assert.equal(envelope.branch, null, "branch is null when not inside a git work tree");

		const prompt = buildPrompt(envelope, dir);
		assert.ok(prompt.includes("Branch: (no git work tree)"), "prompt surfaces the '(no git)' fallback");
		assert.ok(!prompt.includes("ERROR"), "no ERROR string is emitted when git is unavailable");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
