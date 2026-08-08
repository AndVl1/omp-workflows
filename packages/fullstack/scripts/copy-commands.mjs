#!/usr/bin/env node
/**
 * copy-commands.mjs — bootstrap OMP custom-TS commands.
 *
 * OMP discovers custom-TS commands from `.omp/commands/<name>/index.ts` in
 * the consuming project. This script copies the shipped commands from
 * `packages/fullstack/commands/` into that location so OMP can find them.
 *
 * Targets (in priority order):
 *   1. `$OMP_PROJECT_DIR/.omp/commands/` if OMP_PROJECT_DIR is set
 *   2. `./.omp/commands/` in the current working directory
 *
 * Run:
 *   node scripts/copy-commands.mjs              # uses cwd
 *   node scripts/copy-commands.mjs /path/to/... # explicit target
 *   OMP_PROJECT_DIR=/path node scripts/copy-commands.mjs
 *
 * Idempotent: existing files are overwritten with the shipped versions.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shippedDir = resolve(__dirname, "..", "commands");

/**
 * Command directories shipped by OLDER plugin versions before the manifest
 * existed. They are plugin-owned artifacts and are pruned on sync; user-owned
 * command directories (never shipped, never in this list) are preserved.
 */
const LEGACY_REMOVED_COMMANDS = ["team-next", "team-yolo", "pulse", "coordinator-stats"];
const SHIPPED_MANIFEST_FILE = ".omp-shipped.json";

const targetArg = process.argv[2];
const projectRoot = process.env.OMP_PROJECT_DIR || process.env.INIT_CWD || targetArg || process.cwd();
const targetDir = resolve(projectRoot, ".omp", "commands");

function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Converge `.omp/commands/` to the shipped set: remove plugin-owned command
 * directories that no longer ship (manifest-tracked or legacy shipped
 * names), preserve explicitly user-owned commands, and rewrite the manifest
 * with the current shipped set. Mirrors pruneStaleCommands in
 * src/copy-commands.ts (this script is standalone so it cannot import the
 * TS module).
 */
function pruneStaleCommands(targetRoot, shippedNames) {
	let tracked = [];
	try {
		const raw = JSON.parse(readFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE), "utf8"));
		if (Array.isArray(raw?.shipped)) tracked = raw.shipped.filter((name) => typeof name === "string");
	} catch {
		// missing/malformed manifest — nothing tracked yet
	}
	const removed = [];
	let entries;
	try {
		entries = readdirSync(targetRoot, { withFileTypes: true });
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (shippedNames.includes(entry.name)) continue;
		if (!tracked.includes(entry.name) && !LEGACY_REMOVED_COMMANDS.includes(entry.name)) continue;
		try {
			rmSync(join(targetRoot, entry.name), { recursive: true, force: true });
			removed.push(entry.name);
		} catch {
			// best-effort — retried on the next sync
		}
	}
	try {
		writeFileSync(
			join(targetRoot, SHIPPED_MANIFEST_FILE),
			`${JSON.stringify({ schema: 1, shipped: shippedNames }, null, 2)}\n`,
		);
	} catch {
		// best-effort
	}
	if (removed.length > 0) {
		console.log(`copy-commands: pruned stale plugin-owned commands: ${removed.join(", ")}`);
	}
	return removed;
}

function copyTree(src, dst) {
	if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
	let entries;
	try {
		entries = readdirSync(src, { withFileTypes: true });
	} catch (e) {
		console.error(`copy-commands: failed to read ${src}: ${e.message}`);
		process.exitCode = 1;
		return;
	}
	for (const entry of entries) {
		const s = join(src, entry.name);
		const d = join(dst, entry.name);
		if (entry.isDirectory()) {
			// Skip node_modules; everything else (including _lib and other
			// private helpers) is copied so commands with file-local deps
			// resolve correctly. OMP itself only discovers directories
			// directly under `.omp/commands/`, so `_lib` won't be picked
			// up as a command target.
			if (entry.name === "node_modules") continue;
			copyTree(s, d);
		} else if (entry.isFile()) {
			copyFileSync(s, d);
			console.log(`  ${entry.name} -> ${d}`);
		}
	}
}

if (!isDirectory(shippedDir)) {
	console.error(`copy-commands: shipped commands not found at ${shippedDir}`);
	process.exit(1);
}

console.log(`copy-commands: ${shippedDir} -> ${targetDir}`);
const shippedNames = [];
for (const entry of readdirSync(shippedDir, { withFileTypes: true })) {
	if (entry.isDirectory() && !entry.name.startsWith(".")) shippedNames.push(entry.name);
}
copyTree(shippedDir, targetDir);
pruneStaleCommands(targetDir, shippedNames);
console.log("copy-commands: done");
