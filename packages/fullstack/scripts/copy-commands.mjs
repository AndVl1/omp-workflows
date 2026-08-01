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

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shippedDir = resolve(__dirname, "..", "commands");

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
copyTree(shippedDir, targetDir);
console.log("copy-commands: done");
