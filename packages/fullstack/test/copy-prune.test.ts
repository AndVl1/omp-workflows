/**
 * RC6 regression tests: command synchronization converges to the shipped
 * set — plugin-owned stale command dirs (team-next, team-yolo, pulse,
 * coordinator-stats, and any manifest-tracked removed entry) are pruned
 * while explicitly user-owned commands are preserved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LEGACY_REMOVED_COMMANDS,
	SHIPPED_MANIFEST_FILE,
	copyCommandsForInstall,
	ensureCommandsForSession,
	pruneStaleCommands,
	resolveShippedCommandsDir,
} from "../src/copy-commands.js";

function freshProjectDir(): string {
	return mkdtempSync(join(tmpdir(), "omp-prune-test-"));
}

function writeCommand(target: string, name: string, body: string): void {
	const dir = join(target, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.ts"), body, "utf8");
}

const COMMAND_BODY = `// command stub
export default () => ({ name: "x", execute: async () => "ok" });
`;

test("fullstack: stale plugin-owned commands are pruned, user-owned preserved", () => {
	const dir = freshProjectDir();
	try {
		const target = join(dir, ".omp", "commands");
		// Seed the four known legacy plugin-owned stale dirs plus a user-owned
		// command and a shared _lib helper.
		for (const name of LEGACY_REMOVED_COMMANDS) writeCommand(target, name, COMMAND_BODY);
		writeCommand(target, "my-custom-helper", "// user-owned\n" + COMMAND_BODY);
		mkdirSync(join(target, "_lib"), { recursive: true });
		writeFileSync(join(target, "_lib", "util.ts"), "export const x = 1;\n");

		const result = ensureCommandsForSession(dir);
		assert.equal(result.errors.length, 0, `errors: ${result.errors.join(" | ")}`);

		for (const name of LEGACY_REMOVED_COMMANDS) {
			assert.equal(existsSync(join(target, name)), false, `${name} must be pruned after sync`);
		}
		assert.equal(existsSync(join(target, "my-custom-helper")), true, "user-owned command must survive");
		assert.equal(existsSync(join(target, "_lib")), true, "shared _lib helper must survive");
		assert.equal(existsSync(join(target, "init-team")), true, "current copied custom command must be present");

		// The manifest records only project-local compatibility commands.
		const manifest = JSON.parse(readFileSync(join(target, SHIPPED_MANIFEST_FILE), "utf8")) as { shipped: string[] };
		assert.ok(manifest.shipped.includes("init-team"), "manifest tracks copied compatibility commands");
		assert.ok(!manifest.shipped.includes("do-work"), "extension-owned commands are never manifest-tracked");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: manifest-tracked removed commands are pruned on upgrade", () => {
	const dir = freshProjectDir();
	try {
		const target = join(dir, ".omp", "commands");
		// First sync: manifest written with the current shipped set.
		ensureCommandsForSession(dir);
		const manifestPath = join(target, SHIPPED_MANIFEST_FILE);
		const before = JSON.parse(readFileSync(manifestPath, "utf8")) as { shipped: string[] };
		assert.ok(before.shipped.includes("init-team"));

		// Simulate an upgrade: "ghost" was shipped by the previous version
		// (so it is manifest-tracked) but is gone from the shipped set now.
		const next = [...before.shipped, "ghost"];
		writeFileSync(manifestPath, JSON.stringify({ schema: 1, shipped: next }));
		writeCommand(target, "ghost", COMMAND_BODY);

		ensureCommandsForSession(dir);
		assert.equal(existsSync(join(target, "ghost")), false, "manifest-tracked removed command must be pruned");
		assert.equal(existsSync(join(target, "init-team")), true, "current copied command untouched");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: copyCommandsForInstall also prunes stale dirs", () => {
	const dir = freshProjectDir();
	try {
		const target = join(dir, ".omp", "commands");
		writeCommand(target, "team-yolo", COMMAND_BODY);
		writeCommand(target, "user-keep", "// mine\n" + COMMAND_BODY);

		const result = copyCommandsForInstall(dir);
		assert.ok(result.copied.includes("init-team"), "install copies the compatibility command set");
		assert.equal(existsSync(join(target, "team-yolo")), false, "install prunes legacy stale dirs");
		assert.equal(existsSync(join(target, "user-keep")), true, "install preserves user-owned dirs");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: pruneStaleCommands is a pure converge helper", () => {
	const dir = freshProjectDir();
	try {
		const target = join(dir, ".omp", "commands");
		writeCommand(target, "team-next", COMMAND_BODY);
		writeCommand(target, "keep-me", COMMAND_BODY);
		mkdirSync(target, { recursive: true });

		const removed = pruneStaleCommands(target, ["cto", "do-work"]);
		assert.deepEqual(removed, ["team-next"], "only plugin-owned stale dir removed");
		assert.equal(existsSync(join(target, "keep-me")), true, "untracked dir preserved");
		assert.equal(existsSync(join(target, SHIPPED_MANIFEST_FILE)), true, "manifest written");

		// Idempotent: nothing left to prune.
		assert.deepEqual(pruneStaleCommands(target, ["cto", "do-work"]), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: obsolete workflow adapters are absent from the package tree", () => {
	const shipped = resolveShippedCommandsDir();
	for (const name of ["do-work", "team", "cto"]) {
		assert.equal(existsSync(join(shipped, name)), false, `${name} must not ship as a project-local adapter`);
		assert.ok(LEGACY_REMOVED_COMMANDS.includes(name as never), `${name} must remain in upgrade cleanup`);
	}
});

test("fullstack security: prune leaves a stale command symlink and outside sentinel untouched", () => {
	const dir = freshProjectDir();
	const outside = freshProjectDir();
	try {
		const target = join(dir, ".omp", "commands");
		const outsideSentinel = join(outside, "sentinel.txt");
		writeFileSync(outsideSentinel, "outside prune sentinel\n", "utf8");
		mkdirSync(target, { recursive: true });
		symlinkSync(outside, join(target, "team-next"), "dir");

		assert.deepEqual(pruneStaleCommands(target, []), []);
		assert.equal(readFileSync(outsideSentinel, "utf8"), "outside prune sentinel\n");
		assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
		assert.equal(lstatSync(join(target, "team-next")).isSymbolicLink(), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("fullstack security: prune removes child links without traversing outside", () => {
	const dir = freshProjectDir();
	const outside = freshProjectDir();
	try {
		const target = join(dir, ".omp", "commands");
		const stale = join(target, "team-next");
		const outsideSentinel = join(outside, "sentinel.txt");
		writeFileSync(outsideSentinel, "outside child sentinel\n", "utf8");
		mkdirSync(stale, { recursive: true });
		symlinkSync(outsideSentinel, join(stale, "outside-link"));

		assert.deepEqual(pruneStaleCommands(target, []), ["team-next"]);
		assert.equal(readFileSync(outsideSentinel, "utf8"), "outside child sentinel\n");
		assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
		assert.equal(existsSync(stale), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("fullstack security: prune survives a concurrent stale-command parent swap", async () => {
	const dir = freshProjectDir();
	const outside = freshProjectDir();
	const target = join(dir, ".omp", "commands");
	const stale = join(target, "team-next");
	const backup = join(target, "team-next-backup");
	const outsideSentinel = join(outside, "sentinel.txt");
	try {
		writeCommand(target, "team-next", COMMAND_BODY);
		writeFileSync(outsideSentinel, "outside race sentinel\n", "utf8");
		const racer = spawn(
			process.execPath,
			[
				"-e",
				`const fs=require("node:fs"); const target=process.argv[1]; const backup=process.argv[2]; const outside=process.argv[3]; const end=Date.now()+2000; while(Date.now()<end){ try{fs.renameSync(target,backup)}catch{} try{fs.symlinkSync(outside,target,"dir")}catch{} try{fs.unlinkSync(target)}catch{} try{fs.renameSync(backup,target)}catch{} } try{fs.unlinkSync(target)}catch{} try{fs.renameSync(backup,target)}catch{}`,
				stale,
				backup,
				outside,
			],
			{ stdio: "ignore" },
		);
		try {
			pruneStaleCommands(target, []);
			assert.equal(readFileSync(outsideSentinel, "utf8"), "outside race sentinel\n");
			assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
		} finally {
			if (racer.exitCode === null) {
				racer.kill();
				await once(racer, "exit");
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("fullstack security: bounded target scan rejects many entries without partial prune", () => {
	const dir = freshProjectDir();
	try {
		const target = join(dir, ".omp", "commands");
		writeCommand(target, "team-next", COMMAND_BODY);
		for (let index = 0; index < 4100; index++) {
			mkdirSync(join(target, `unrelated-${index}-${"x".repeat(238)}`));
		}
		const before = readdirSync(target).sort();

		assert.deepEqual(pruneStaleCommands(target, []), []);
		assert.equal(existsSync(join(target, "team-next")), true, "stale command must remain when scan budget is exceeded");
		assert.deepEqual(readdirSync(target).sort(), before, "bounded scan must fail before deleting any entry");
		assert.equal(existsSync(join(target, SHIPPED_MANIFEST_FILE)), false, "manifest must not be rewritten after a failed scan");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("fullstack security: bounded stale-tree scan rejects many children without partial prune", () => {
	const dir = freshProjectDir();
	try {
		const target = join(dir, ".omp", "commands");
		const stale = join(target, "team-next");
		mkdirSync(stale, { recursive: true });
		for (let index = 0; index < 4100; index++) {
			writeFileSync(join(stale, `child-${index}.ts`), "stale\n", "utf8");
		}
		const before = readdirSync(stale).sort();

		assert.deepEqual(pruneStaleCommands(target, []), []);
		assert.equal(existsSync(stale), true, "stale command must remain when child scan exceeds its budget");
		assert.deepEqual(readdirSync(stale).sort(), before, "child validation must finish before any deletion");
		assert.equal(existsSync(join(target, SHIPPED_MANIFEST_FILE)), false, "manifest must not be rewritten after a failed child scan");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const [operationName, operation] of [
	["session sync", ensureCommandsForSession],
	["force install copy", copyCommandsForInstall],
] as const) {
	test(`fullstack security: ${operationName} rejects a hostile target scan before mutation`, () => {
		const dir = freshProjectDir();
		try {
			const target = join(dir, ".omp", "commands");
			writeCommand(target, "team-next", COMMAND_BODY);
			for (let index = 0; index < 4100; index++) {
				mkdirSync(join(target, `unrelated-${index}-${"x".repeat(238)}`));
			}
			const before = readdirSync(target).sort();

			const result = operation(dir);
			assert.ok(result.errors.length > 0, "hostile target scan should fail closed");
			assert.equal(existsSync(join(target, "team-next")), true, "stale command must remain");
			assert.deepEqual(readdirSync(target).sort(), before, "target scan must happen before copying or pruning");
			assert.equal(existsSync(join(target, SHIPPED_MANIFEST_FILE)), false, "manifest must remain untouched");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}