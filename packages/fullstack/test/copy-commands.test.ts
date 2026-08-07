/**
 * Smoke test: the copy-commands bootstrap helper.
 *
 * Covers `ensureCommandsForSession` (the path used by the `session_start`
 * extension hook) and the install-time force-copy helper. The shipped
 * commands live at `<fullstack>/commands/`; we point the helpers at a
 * tmpdir and verify the outcomes without touching the real `.omp/`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	copyCommandsForInstall,
	ensureCommandsForSession,
	resolveShippedCommandsDir,
} from "../src/copy-commands.js";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function freshProjectDir(): string {
	return mkdtempSync(join(tmpdir(), "omp-copy-test-"));
}

test("fullstack: resolveShippedCommandsDir returns a real directory in this checkout", () => {
	const dir = resolveShippedCommandsDir();
	// The function lands on either the source tree or the dist tree,
	// depending on how it was imported. Either way, the path must
	// contain `index.ts` for the `do-work` command shipped with 0.5.0+.
	assert.ok(dir.includes("fullstack"), `path should mention fullstack, got ${dir}`);
	assert.ok(dir.endsWith("commands"), `path should end with /commands, got ${dir}`);
});

test("fullstack: ensureCommandsForSession populates a fresh project", () => {
	const dir = freshProjectDir();
	try {
		const result = ensureCommandsForSession(dir);
		assert.ok(result.errors.length === 0, `errors: ${result.errors.join(" | ")}`);
		assert.ok(result.copied.length > 0, "should copy at least one command on a fresh project");
		assert.ok(result.copied.includes("do-work"), "do-work should be copied on a fresh project");

		// Spot-check the copied tree: <dir>/.omp/commands/do-work/index.ts exists
    // The copied entrypoint is a thin adapter over the core command contract.
    const doWorkIndex = join(dir, ".omp", "commands", "do-work", "index.ts");
    assert.ok(readFileSync(doWorkIndex, "utf8").includes("@andvl1/omp-workflows-core"), "do-work adapter consumes core contract");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: ensureCommandsForSession is idempotent — second run reports nothing to copy", () => {
	const dir = freshProjectDir();
	try {
		const first = ensureCommandsForSession(dir);
		assert.ok(first.copied.length > 0);

		const second = ensureCommandsForSession(dir);
		assert.equal(second.copied.length, 0, "no commands should be re-copied on second run");
		assert.equal(second.errors.length, 0, "no errors on the second run either");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: ensureCommandsForSession preserves user-modified files", () => {
	const dir = freshProjectDir();
	try {
		ensureCommandsForSession(dir);
		const userFile = join(dir, ".omp", "commands", "do-work", "index.ts");
		const before = readFileSync(userFile, "utf8");
		const custom = "// user customization marker\n" + before;
		writeFileSync(userFile, custom, "utf8");

		const result = ensureCommandsForSession(dir);
		assert.equal(result.copied.length, 0, "no files should be overwritten on a third run");
		const after = readFileSync(userFile, "utf8");
		assert.ok(after.startsWith("// user customization marker"), "user edits must survive");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: copyCommandsForInstall overwrites existing files (force-copy)", () => {
	const dir = freshProjectDir();
	try {
		const first = copyCommandsForInstall(dir);
		assert.ok(first.copied.length > 0);

		const victim = join(dir, ".omp", "commands", "do-work", "index.ts");
		writeFileSync(victim, "// should be replaced\n", "utf8");

		const second = copyCommandsForInstall(dir);
		assert.ok(
			second.copied.includes("do-work"),
			"copyCommandsForInstall must force-copy do-work over the user's edits",
		);
		const after = readFileSync(victim, "utf8");
		assert.ok(!after.startsWith("// should be replaced"), "the user's edit must be replaced");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

