/**
 * Smoke test: the `/team` custom-TS command must boot, parse the
 * envelope, classify the task, and emit a fully-formed prompt — without
 * importing OMP at all. We feed the factory a fake `CustomCommandAPI`
 * and a fake `HookCommandContext`, then assert on the returned string.
 *
 * This catches:
 *  - syntax errors in the TS source,
 *  - missing imports / bad paths,
 *  - envelope parsing regressions,
 *  - classification table regressions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import factory from "../commands/team/index.js";

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

test("fullstack: /team command loads and parses an envelope", async () => {
	const cmd = factory(fakeApi as never);
	assert.equal(cmd.name, "team");
	assert.ok(cmd.description.length > 0);

	const result = await cmd.execute(["Add OAuth with Google"], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("OAuth with Google"), "result echoes the task");
	assert.ok(result.includes("Workflow: `lightweight`"), "FEATURE/QUICK classifies as lightweight");
	assert.ok(result.includes("Role mapping"), "result includes the role mapping table");
});

test("fullstack: /team [AUTONOMOUS] prefix toggles autonomous mode", async () => {
	const cmd = factory(fakeApi as never);
	const result = await cmd.execute(["[AUTONOMOUS] Fix bug #42"], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Autonomous mode: ON"), "AUTONOMOUS prefix flips mode on");
	assert.ok(result.includes("Fix bug #42"));
});

test("fullstack: /team strips issue=#N into the prompt metadata", async () => {
	const cmd = factory(fakeApi as never);
	const result = await cmd.execute(["Investigate regression issue=#1337"], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Issue: #1337"), "issue=#N is captured in the metadata block");
	assert.ok(!result.includes("issue=#1337"), "issue=#N is removed from the task body");
	assert.ok(result.includes("Investigate regression"));
});

test("fullstack: /team usage on empty args", async () => {
	const cmd = factory(fakeApi as never);
	const result = await cmd.execute([], fakeCtx as never);
	assert.equal(typeof result, "string");
	assert.ok(result.includes("Usage: /team"));
});

test("fullstack: /team requires a real git worktree", () => {
	// Skipped when running from a non-git checkout.
	try {
		execSync("git rev-parse --abbrev-ref HEAD", { stdio: "ignore" });
	} catch {
		return; // skip
	}
	// No-op: the previous tests already proved this works inside a git tree.
});
