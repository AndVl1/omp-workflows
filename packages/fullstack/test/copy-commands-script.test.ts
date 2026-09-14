import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveShippedCommandsDir, SHIPPED_MANIFEST_FILE } from "../src/copy-commands.js";

function freshProjectDir(): string {
	return mkdtempSync(join(tmpdir(), "omp-copy-script-test-"));
}

function scriptPath(): string {
	return join(resolveShippedCommandsDir(), "..", "scripts", "copy-commands.mjs");
}

function runScript(projectRoot: string): SpawnSyncReturns<string> {
	const env = { ...process.env };
	delete env.OMP_PROJECT_DIR;
	delete env.INIT_CWD;
	return spawnSync(process.execPath, [scriptPath()], {
		cwd: projectRoot,
		env,
		encoding: "utf8",
		stdio: "pipe",
	});
}

function output(value: string | Buffer | null | undefined): string {
	return value === null || value === undefined ? "" : value.toString();
}

test("fullstack script: no target remains a clean no-op success", () => {
	const projectRoot = freshProjectDir();
	try {
		const result = runScript(projectRoot);
		assert.equal(result.status, 0, output(result.stderr));
		assert.equal(existsSync(join(projectRoot, ".omp", "commands", SHIPPED_MANIFEST_FILE)), true);
	} finally {
		rmSync(projectRoot, { recursive: true, force: true });
	}
});

test("fullstack script: rejects a symlinked .omp/commands root without touching its target", () => {
	const projectRoot = freshProjectDir();
	const outsideRoot = freshProjectDir();
	const sentinel = join(outsideRoot, "sentinel.txt");
	try {
		writeFileSync(sentinel, "outside\n", "utf8");
		mkdirSync(join(projectRoot, ".omp"), { recursive: true });
		symlinkSync(outsideRoot, join(projectRoot, ".omp", "commands"), "dir");

		const result = runScript(projectRoot);
		assert.notEqual(result.status, 0, output(result.stderr));
		assert.equal(readFileSync(sentinel, "utf8"), "outside\n");
		assert.equal(lstatSync(join(projectRoot, ".omp", "commands")).isSymbolicLink(), true);
	} finally {
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(outsideRoot, { recursive: true, force: true });
	}
});

test("fullstack script: rejects a symlinked shipped child without mutating the outside target", () => {
	const projectRoot = freshProjectDir();
	const outsideRoot = freshProjectDir();
	const targetRoot = join(projectRoot, ".omp", "commands");
	const outsideTarget = join(outsideRoot, "init-team");
	const sentinel = join(outsideTarget, "sentinel.txt");
	try {
		mkdirSync(targetRoot, { recursive: true });
		mkdirSync(outsideTarget, { recursive: true });
		writeFileSync(sentinel, "outside\n", "utf8");
		symlinkSync(outsideTarget, join(targetRoot, "init-team"), "dir");

		const result = runScript(projectRoot);
		assert.notEqual(result.status, 0, output(result.stderr));
		assert.equal(readFileSync(sentinel, "utf8"), "outside\n");
		assert.equal(lstatSync(join(targetRoot, "init-team")).isSymbolicLink(), true);
	} finally {
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(outsideRoot, { recursive: true, force: true });
	}
});

test("fullstack script: rejects a manifest traversal entry before copying or pruning", () => {
	const projectRoot = freshProjectDir();
	const outsideRoot = freshProjectDir();
	const targetRoot = join(projectRoot, ".omp", "commands");
	const sentinel = join(outsideRoot, "escape.txt");
	try {
		mkdirSync(targetRoot, { recursive: true });
		writeFileSync(sentinel, "outside\n", "utf8");
		writeFileSync(
			join(targetRoot, SHIPPED_MANIFEST_FILE),
			JSON.stringify({ schema: 2, shipped: ["../escape"], files: {} }),
			"utf8",
		);

		const result = runScript(projectRoot);
		assert.notEqual(result.status, 0, output(result.stderr));
		assert.equal(readFileSync(sentinel, "utf8"), "outside\n");
		assert.equal(readFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE), "utf8").includes("../escape"), true);
	} finally {
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(outsideRoot, { recursive: true, force: true });
	}
});

test("fullstack script: removes a manifest-tracked stale directory without following child links", () => {
	const projectRoot = freshProjectDir();
	const outsideRoot = freshProjectDir();
	const targetRoot = join(projectRoot, ".omp", "commands");
	const staleRoot = join(targetRoot, "old-command");
	const sentinel = join(outsideRoot, "sentinel.txt");
	try {
		mkdirSync(staleRoot, { recursive: true });
		writeFileSync(join(staleRoot, "index.ts"), "// stale\n", "utf8");
		writeFileSync(sentinel, "outside\n", "utf8");
		symlinkSync(sentinel, join(staleRoot, "outside-link"));
		writeFileSync(
			join(targetRoot, SHIPPED_MANIFEST_FILE),
			JSON.stringify({ schema: 2, shipped: ["old-command"], files: {} }),
			"utf8",
		);

		const result = runScript(projectRoot);
		assert.equal(result.status, 0, output(result.stderr));
		assert.equal(existsSync(staleRoot), false);
		assert.equal(readFileSync(sentinel, "utf8"), "outside\n");
		assert.equal(existsSync(join(targetRoot, "init-team")), true);
	} finally {
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(outsideRoot, { recursive: true, force: true });
	}
});
