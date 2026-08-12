/**
 * Smoke test: the copy-commands bootstrap helper.
 *
 * Covers `ensureCommandsForSession` (the path used by the `session_start`
 * extension hook) and the install-time force-copy helper. The shipped
 * commands live at `<fullstack>/commands/`; we point the helpers at a
 * tmpdir and verify the outcomes without touching the real `.omp/`.
 */

import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SHIPPED_MANIFEST_FILE,
	copyCommandsForInstall,
	ensureCommandsForSession,
	resolveShippedCommandsDir,
} from "../src/copy-commands.js";

function freshProjectDir(): string {
	return mkdtempSync(join(tmpdir(), "omp-copy-test-"));
}
function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

test("fullstack: resolveShippedCommandsDir returns a real directory in this checkout", () => {
	const dir = resolveShippedCommandsDir();
	// The function lands on either the source tree or the dist tree,
	// depending on how it was imported. Either way, the path must
	// contain `index.ts` for the `do-work` command shipped with 0.5.0+.
	assert.ok(dir.includes("fullstack"), `path should mention fullstack, got ${dir}`);
	assert.ok(dir.endsWith("commands"), `path should end with /commands, got ${dir}`);
});

test("fullstack: session sync copies only non-workflow custom commands", () => {
	const dir = freshProjectDir();
	try {
		const result = ensureCommandsForSession(dir);
		assert.ok(result.errors.length === 0, `errors: ${result.errors.join(" | ")}`);
		assert.ok(result.copied.includes("init-team"), "remaining custom commands are copied");
		for (const command of ["do-work", "team", "cto"]) {
			assert.equal(existsSync(join(dir, ".omp", "commands", command)), false, `${command} is extension-owned`);
		}
		const manifest = JSON.parse(readFileSync(join(dir, ".omp", "commands", SHIPPED_MANIFEST_FILE), "utf8")) as {
			schema: number;
			files: Record<string, string>;
		};
		assert.equal(manifest.schema, 2);
		assert.ok(manifest.files["init-team/index.ts"]);
		assert.equal(manifest.files["do-work/index.ts"], undefined);
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

test("fullstack: session sync preserves user-owned custom commands", () => {
	const dir = freshProjectDir();
	try {
		const userFile = join(dir, ".omp", "commands", "my-command", "index.ts");
		mkdirSync(join(dir, ".omp", "commands", "my-command"), { recursive: true });
		writeFileSync(userFile, "// user command\n", "utf8");
		ensureCommandsForSession(dir);
		assert.equal(readFileSync(userFile, "utf8"), "// user command\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: install sync removes obsolete workflow adapters", () => {
	const dir = freshProjectDir();
	try {
		for (const command of ["do-work", "team", "cto"]) {
			const commandDir = join(dir, ".omp", "commands", command);
			mkdirSync(commandDir, { recursive: true });
			writeFileSync(join(commandDir, "index.ts"), "legacy");
		}
		const result = copyCommandsForInstall(dir);
		assert.equal(result.errors.length, 0);
		for (const command of ["do-work", "team", "cto"]) {
			assert.equal(existsSync(join(dir, ".omp", "commands", command)), false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: install script writes the same hash manifest", () => {
	const dir = freshProjectDir();
	try {
		const scriptPath = join(resolveShippedCommandsDir(), "..", "scripts", "copy-commands.mjs");
		execFileSync(process.execPath, [scriptPath, dir], {
			cwd: resolveShippedCommandsDir(),
			env: { ...process.env, OMP_PROJECT_DIR: dir },
			stdio: "pipe",
		});
		const manifest = JSON.parse(readFileSync(join(dir, ".omp", "commands", SHIPPED_MANIFEST_FILE), "utf8")) as {
			schema: number;
			files: Record<string, string>;
		};
		assert.equal(manifest.schema, 2);
		const source = readFileSync(join(resolveShippedCommandsDir(), "init-team", "index.ts"), "utf8");
		assert.equal(manifest.files["init-team/index.ts"], sha256(source));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: session sync removes obsolete workflow adapters and preserves unrelated commands", () => {
	const dir = freshProjectDir();
	try {
		const target = join(dir, ".omp", "commands");
		for (const command of ["do-work", "team", "cto"]) {
			mkdirSync(join(target, command), { recursive: true });
			writeFileSync(join(target, command, "index.ts"), "legacy");
		}
		mkdirSync(join(target, "user-command"), { recursive: true });
		writeFileSync(join(target, "user-command", "index.ts"), "user-owned");

		const result = ensureCommandsForSession(dir);
		assert.equal(result.errors.length, 0);
		for (const command of ["do-work", "team", "cto"]) {
			assert.equal(existsSync(join(target, command)), false);
		}
		assert.equal(readFileSync(join(target, "user-command", "index.ts"), "utf8"), "user-owned");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

