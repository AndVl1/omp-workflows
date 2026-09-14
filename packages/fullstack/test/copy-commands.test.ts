/**
 * Smoke test: the copy-commands bootstrap helper.
 *
 * Covers `ensureCommandsForSession` as an explicitly invoked legacy
 * disk-discovery sync and the install-time force-copy helper. The extension's
 * supported-host `session_start` path does not call either helper. The
 * shipped commands live at `<fullstack>/commands/`; we point the helpers at a
 * tmpdir and verify the outcomes without touching the real `.omp/`.
 */

import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SHIPPED_MANIFEST_FILE,
	copyCommandsForInstall,
	ensureCommandsForSession,
	resolveShippedCommandsDir,
} from "../src/copy-commands.js";
import {
	FULLSTACK_ACTIVATION_MARKER_BYTES,
	FULLSTACK_ACTIVATION_MARKER_PATH,
	FULLSTACK_ACTIVATION_MARKER_SHA256,
	parseFullstackActivationMarker,
	readFullstackActivationMarker,
	writeFullstackActivationMarker,
} from "../src/activation-marker.js";

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


test("fullstack: install reports typed stale-prune failure instead of stale success", () => {
	const dir = freshProjectDir();
	try {
		const result = copyCommandsForInstall(dir, {
			hooks: {
				pruneStaleCommands: () => {
					throw new Error("injected stale prune failure");
				},
			},
		});
		assert.equal(result.failure?.code, "stale_prune_failed");
		assert.match(result.failure?.message ?? "", /injected stale prune failure/);
		assert.equal(result.errors.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: install reports typed manifest-write failure", () => {
	const dir = freshProjectDir();
	try {
		const result = copyCommandsForInstall(dir, {
			hooks: {
				writeManifest: () => {
					throw new Error("injected manifest write failure");
				},
			},
		});
		assert.equal(result.failure?.code, "manifest_write_failed");
		assert.match(result.failure?.message ?? "", /injected manifest write failure/);
		assert.equal(result.errors.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack: session reports typed prune failure and preserves diagnostic result", () => {
	const dir = freshProjectDir();
	try {
		const result = ensureCommandsForSession(dir, {
			hooks: {
				pruneStaleCommands: () => {
					throw new Error("injected session prune failure");
				},
			},
		});
		assert.equal(result.failure?.code, "stale_prune_failed");
		assert.match(result.failure?.message ?? "", /injected session prune failure/);
		assert.equal(result.errors.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const hostileOperations = [
	["session sync", ensureCommandsForSession],
	["force install copy", copyCommandsForInstall],
] as const;

const hostileDestinations = [
	["file symlink", "file-symlink"],
	["parent symlink", "parent-symlink"],
	["directory", "directory"],
	["FIFO", "fifo"],
] as const;

for (const [operationName, operation] of hostileOperations) {
	for (const [destinationName, destinationKind] of hostileDestinations) {
		if (destinationKind === "fifo" && process.platform === "win32") continue;
		test(`fullstack security: ${operationName} rejects ${destinationName} without touching outside`, () => {
			const dir = freshProjectDir();
			const outside = freshProjectDir();
			try {
				const targetRoot = join(dir, ".omp", "commands");
				const commandDir = join(targetRoot, "init-team");
				const target = join(commandDir, "index.ts");
				const outsideSentinel = join(outside, "sentinel.ts");
				const sentinel = "outside sentinel — must remain byte-identical\n";
				mkdirSync(targetRoot, { recursive: true });
				writeFileSync(outsideSentinel, sentinel, "utf8");

				if (destinationKind === "file-symlink") {
					mkdirSync(commandDir, { recursive: true });
					symlinkSync(outsideSentinel, target);
				} else if (destinationKind === "parent-symlink") {
					symlinkSync(outside, commandDir, "dir");
				} else if (destinationKind === "directory") {
					mkdirSync(target, { recursive: true });
				} else {
					mkdirSync(commandDir, { recursive: true });
					execFileSync("mkfifo", [target]);
				}

				const result = operation(dir);
				assert.ok(result.errors.length > 0, `hostile destination should report an error: ${result.errors.join(" | ")}`);
				assert.equal(readFileSync(outsideSentinel, "utf8"), sentinel);
				assert.deepEqual(readdirSync(outside).sort(), ["sentinel.ts"]);

				const entry = lstatSync(destinationKind === "parent-symlink" ? commandDir : target);
				if (destinationKind.includes("symlink")) {
					assert.equal(entry.isSymbolicLink(), true);
				} else if (destinationKind === "directory") {
					assert.equal(entry.isDirectory(), true);
				} else {
					assert.equal(entry.mode & 0o170000, 0o010000, "FIFO must remain a FIFO");
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
				rmSync(outside, { recursive: true, force: true });
			}
		});
	}
}

for (const [operationName, operation] of hostileOperations) {
	test(`fullstack security: ${operationName} survives a concurrent command-parent swap`, async () => {
		const dir = freshProjectDir();
		const outside = freshProjectDir();
		const targetRoot = join(dir, ".omp", "commands");
		const commandDir = join(targetRoot, "init-team");
		const backupDir = join(targetRoot, "init-team-backup");
		const outsideSentinel = join(outside, "sentinel.ts");
		const sentinel = "concurrent outside sentinel — must remain byte-identical\n";
		try {
			mkdirSync(commandDir, { recursive: true });
			writeFileSync(outsideSentinel, sentinel, "utf8");
			const racer = spawn(
				process.execPath,
				[
					"-e",
					`const fs=require("node:fs"); const command=process.argv[1]; const backup=process.argv[2]; const outside=process.argv[3]; const end=Date.now()+2000; while(Date.now()<end){ try{fs.renameSync(command,backup)}catch{} try{fs.symlinkSync(outside,command,"dir")}catch{} try{fs.unlinkSync(command)}catch{} try{fs.renameSync(backup,command)}catch{} } try{fs.unlinkSync(command)}catch{} try{fs.renameSync(backup,command)}catch{}`,
					commandDir,
					backupDir,
					outside,
				],
				{ stdio: "ignore" },
			);
			try {
				operation(dir);
				assert.equal(readFileSync(outsideSentinel, "utf8"), sentinel);
				assert.deepEqual(readdirSync(outside).sort(), ["sentinel.ts"]);
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
}

for (const [operationName, operation] of hostileOperations) {
	test(`fullstack security: ${operationName} creates private command directories and files under umask 000`, () => {
		const dir = freshProjectDir();
		const targetRoot = join(dir, ".omp", "commands");
		const previousUmask = process.umask(0);
		try {
			const result = operation(dir);
			assert.equal(result.errors.length, 0, `secure first copy should succeed: ${result.errors.join(" | ")}`);
			assert.equal(lstatSync(targetRoot).mode & 0o777, 0o700);
			assert.equal(lstatSync(join(targetRoot, "init-team")).mode & 0o777, 0o700);
			assert.equal(lstatSync(join(targetRoot, "init-team", "index.ts")).mode & 0o777, 0o600);
			assert.equal(lstatSync(join(targetRoot, SHIPPED_MANIFEST_FILE)).mode & 0o777, 0o600);
		} finally {
			process.umask(previousUmask);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test(`fullstack security: ${operationName} normalizes owned world-writable destinations`, () => {
		const dir = freshProjectDir();
		const targetRoot = join(dir, ".omp", "commands");
		try {
			mkdirSync(targetRoot, { recursive: true });
			chmodSync(targetRoot, 0o777);
			const first = operation(dir);
			assert.equal(first.errors.length, 0, `initial copy should succeed: ${first.errors.join(" | ")}`);
			const target = join(targetRoot, "init-team", "index.ts");
			chmodSync(target, 0o666);
			const second = operation(dir);
			assert.equal(second.errors.length, 0, `normalization copy should succeed: ${second.errors.join(" | ")}`);
			assert.equal(lstatSync(targetRoot).mode & 0o777, 0o700);
			assert.equal(lstatSync(target).mode & 0o777, 0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

for (const [operationName, operation] of hostileOperations) {
	test(`fullstack security: ${operationName} rejects an oversized manifest before copying`, () => {
		const dir = freshProjectDir();
		try {
			const targetRoot = join(dir, ".omp", "commands");
			mkdirSync(targetRoot, { recursive: true });
			const oversized = Buffer.alloc(256 * 1024 + 1, 0x78);
			writeFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE), oversized);

			const result = operation(dir);
			assert.ok(result.errors.length > 0, "oversized manifest should be rejected");
			assert.equal(existsSync(join(targetRoot, "init-team")), false);
			assert.deepEqual(readFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE)), oversized);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test(`fullstack security: ${operationName} rejects invalid UTF-8 manifest before copying`, () => {
		const dir = freshProjectDir();
		try {
			const targetRoot = join(dir, ".omp", "commands");
			mkdirSync(targetRoot, { recursive: true });
			const invalid = Buffer.from([0xff, 0xfe, 0xfd]);
			writeFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE), invalid);

			const result = operation(dir);
			assert.ok(result.errors.length > 0, "invalid UTF-8 manifest should be rejected");
			assert.equal(existsSync(join(targetRoot, "init-team")), false);
			assert.deepEqual(readFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE)), invalid);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	if (process.platform !== "win32") {
		test(`fullstack security: ${operationName} rejects a manifest FIFO without blocking`, () => {
			const dir = freshProjectDir();
			try {
				const targetRoot = join(dir, ".omp", "commands");
				mkdirSync(targetRoot, { recursive: true });
				execFileSync("mkfifo", [join(targetRoot, SHIPPED_MANIFEST_FILE)]);

				const result = operation(dir);
				assert.ok(result.errors.length > 0, "manifest FIFO should be rejected");
				assert.equal(existsSync(join(targetRoot, "init-team")), false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
}

for (const [operationName, operation] of hostileOperations) {
	test(`fullstack security: ${operationName} rejects a manifest with too many entries before copying`, () => {
		const dir = freshProjectDir();
		try {
			const targetRoot = join(dir, ".omp", "commands");
			mkdirSync(targetRoot, { recursive: true });
			const manifest = Buffer.from(JSON.stringify({
				schema: 2,
				shipped: Array.from({ length: 1025 }, (_, index) => `ghost-${index}`),
				files: {},
			}), "utf8");
			writeFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE), manifest);

			const result = operation(dir);
			assert.ok(result.errors.length > 0, "manifest entry limit should be enforced");
			assert.equal(existsSync(join(targetRoot, "init-team")), false);
			assert.deepEqual(readFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE)), manifest);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("fullstack activation marker: canonical bytes, hash, parser, and repeat are stable", () => {
	const dir = freshProjectDir();
	try {
		const markerPath = join(dir, FULLSTACK_ACTIVATION_MARKER_PATH);
		assert.equal(
			createHash("sha256").update(FULLSTACK_ACTIVATION_MARKER_BYTES).digest("hex"),
			FULLSTACK_ACTIVATION_MARKER_SHA256,
		);
		writeFullstackActivationMarker(dir);
		assert.deepEqual(readFileSync(markerPath), FULLSTACK_ACTIVATION_MARKER_BYTES);
		assert.deepEqual(parseFullstackActivationMarker(FULLSTACK_ACTIVATION_MARKER_BYTES), {
			schema_version: 1,
			bundle_id: "@andvl1/omp-workflows-fullstack",
			entrypoint: "dist/index.js",
		});
		const before = lstatSync(markerPath);
		writeFullstackActivationMarker(dir);
		const after = lstatSync(markerPath);
		assert.equal(after.dev, before.dev);
		assert.equal(after.ino, before.ino);
		assert.deepEqual(readFullstackActivationMarker(dir), {
			schema_version: 1,
			bundle_id: "@andvl1/omp-workflows-fullstack",
			entrypoint: "dist/index.js",
		});
		const installer = copyCommandsForInstall(dir);
		assert.equal(installer.errors.length, 0, installer.errors.join(" | "));
		assert.deepEqual(readFileSync(markerPath), FULLSTACK_ACTIVATION_MARKER_BYTES);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack activation marker: missing read does not create project state", () => {
	const dir = freshProjectDir();
	try {
		assert.equal(readFullstackActivationMarker(dir), null);
		assert.equal(existsSync(join(dir, ".omp")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack activation marker: malformed conflict is preserved and blocks installer before copy", () => {
	const dir = freshProjectDir();
	const markerPath = join(dir, FULLSTACK_ACTIVATION_MARKER_PATH);
	const commandPath = join(dir, ".omp", "commands", "user-command", "index.ts");
	const conflict = Buffer.from('{"schema_version":1,"bundle_id":"other"}\n', "utf8");
	try {
		mkdirSync(join(dir, ".omp", "commands", "user-command"), { recursive: true });
		writeFileSync(markerPath, conflict);
		writeFileSync(commandPath, "user-owned");
		const result = copyCommandsForInstall(dir);
		assert.ok(result.errors.length > 0, "marker conflict must fail explicit installer");
		assert.deepEqual(readFileSync(markerPath), conflict);
		assert.equal(readFileSync(commandPath, "utf8"), "user-owned");
		assert.equal(existsSync(join(dir, ".omp", "commands", "init-team")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack activation marker: symlink and wrong-kind destinations never overwrite", () => {
	const dir = freshProjectDir();
	const outside = freshProjectDir();
	const markerPath = join(dir, FULLSTACK_ACTIVATION_MARKER_PATH);
	const outsidePath = join(outside, "sentinel");
	try {
		mkdirSync(join(dir, ".omp"), { recursive: true });
		writeFileSync(outsidePath, "outside");
		symlinkSync(outsidePath, markerPath);
		assert.throws(() => writeFullstackActivationMarker(dir), /activation marker/u);
		assert.equal(readFileSync(outsidePath, "utf8"), "outside");
		rmSync(markerPath);
		mkdirSync(markerPath);
		assert.throws(() => writeFullstackActivationMarker(dir), /activation marker/u);
		assert.equal(readdirSync(join(dir, ".omp")).includes("fullstack.activation.json"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("fullstack activation marker: parent symlink cannot redirect creation outside project", () => {
	const dir = freshProjectDir();
	const outside = freshProjectDir();
	try {
		symlinkSync(outside, join(dir, ".omp"));
		assert.throws(() => writeFullstackActivationMarker(dir), /activation marker/u);
		assert.equal(existsSync(join(outside, "fullstack.activation.json")), false);
		assert.equal(readFullstackActivationMarker(dir), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("fullstack activation marker: installer commits marker only after a successful copy", () => {
	const dir = freshProjectDir();
	try {
		const failed = copyCommandsForInstall(dir, {
			hooks: {
				pruneStaleCommands: () => {
					throw new Error("injected copy failure");
				},
			},
		});
		assert.ok(failed.errors.length > 0);
		assert.equal(existsSync(join(dir, FULLSTACK_ACTIVATION_MARKER_PATH)), false);
		const succeeded = copyCommandsForInstall(dir);
		assert.equal(succeeded.errors.length, 0, succeeded.errors.join(" | "));
		assert.deepEqual(readFileSync(join(dir, FULLSTACK_ACTIVATION_MARKER_PATH)), FULLSTACK_ACTIVATION_MARKER_BYTES);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fullstack activation marker: session sync never opts a project in", () => {
	const dir = freshProjectDir();
	try {
		const result = ensureCommandsForSession(dir);
		assert.equal(result.errors.length, 0, result.errors.join(" | "));
		assert.equal(existsSync(join(dir, FULLSTACK_ACTIVATION_MARKER_PATH)), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
