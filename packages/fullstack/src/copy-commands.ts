/**
 * Bootstrap helper: copy the shipped OMP custom-TS slash commands into a
 * project's `.omp/commands/` directory so OMP can discover and execute
 * them. OMP's discovery reads from project-local `.omp/commands/<name>/
 * index.ts` (see `discoverCustomCommands` in @oh-my-pi/pi-coding-agent),
 * not from the installed npm package's node_modules directly.
 *
 * Two entry points exist:
 *
 *  - {@link copyCommandsForInstall}: unconditional copy, used by the
 *    `copy-commands.mjs` CLI script and by the `postinstall` hook.
 *    Overwrites existing files so a fresh install can repair drift.
 *
 *  - {@link ensureCommandsForSession}: conservative copy, used by the
 *    `session_start` extension hook. Skips files that already exist in
 *    the target, so user customizations are preserved. Best-effort:
 *    errors are captured in the result but never thrown.
 *
 * OMP installs plugins into `~/.omp/plugins/`, which is OUTSIDE any
 * project's `node_modules`. As a result, the standard npm `postinstall`
 * hook never fires for `omp plugin install`. The `session_start` hook
 * covers that case: every time the user starts a session in a project,
 * the missing commands land in `.omp/commands/` automatically.
 */

import { copyFileSync, Dirent, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHIPPED_COMMANDS_DIR = "commands";

/**
 * Manifest file written into `.omp/commands/` recording the command names
 * the plugin materialized. Pruning removes a tracked directory once it
 * drops out of the shipped set, converging the target to the shipped set.
 * The manifest is a plain JSON file (not a directory), so OMP's
 * `.omp/commands/<name>/index.ts` discovery never treats it as a command.
 */
export const SHIPPED_MANIFEST_FILE = ".omp-shipped.json";

/**
 * Narrowly scoped migration list: command directories shipped by older
 * plugin versions BEFORE the manifest existed (copied without tracking).
 * They are plugin-owned artifacts, removed on sync, while user-created
 * command directories (never shipped, never in this list) are preserved.
 */
export const LEGACY_REMOVED_COMMANDS = ["team-next", "team-yolo", "pulse", "coordinator-stats"] as const;

export interface CopyCommandsOptions {
	/** Override the target directory; defaults to `<cwd>/.omp/commands`. */
	targetDir?: string;
}

export interface CopyCommandsResult {
	copied: string[];
	skipped: string[];
	errors: string[];
}

interface ShippedManifest {
	schema: 1;
	shipped: string[];
}

function readShippedManifest(targetRoot: string): string[] {
	try {
		const raw = JSON.parse(readFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE), "utf8")) as { shipped?: unknown };
		if (Array.isArray(raw.shipped)) {
			return raw.shipped.filter((name): name is string => typeof name === "string");
		}
	} catch {
		// missing/malformed manifest — nothing tracked yet
	}
	return [];
}

function writeShippedManifest(targetRoot: string, shipped: string[]): void {
	try {
		const manifest: ShippedManifest = { schema: 1, shipped };
		writeFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
	} catch {
		// best-effort — a missing manifest only delays pruning of future removals
	}
}

/**
 * Converge `.omp/commands/` to the shipped set: remove plugin-owned command
 * directories that no longer ship (tracked by the manifest, or from the
 * known legacy shipped set), while preserving explicitly user-owned
 * commands (never tracked, not in the legacy list). Rewrites the manifest
 * with the current shipped set. Returns the removed command names.
 */
export function pruneStaleCommands(targetRoot: string, shippedNames: string[]): string[] {
	const tracked = readShippedManifest(targetRoot);
	const legacy = LEGACY_REMOVED_COMMANDS as readonly string[];
	const removed: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(targetRoot, { withFileTypes: true });
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (shippedNames.includes(entry.name)) continue;
		if (!tracked.includes(entry.name) && !legacy.includes(entry.name)) continue;
		try {
			rmSync(join(targetRoot, entry.name), { recursive: true, force: true });
			removed.push(entry.name);
		} catch {
			// best-effort — a locked directory is retried next session
		}
	}
	writeShippedManifest(targetRoot, shippedNames);
	return removed;
}

/**
 * Resolve the directory the shipped commands live in.
 *
 * Works from both the bundled extension (where commands sit next to the
 * `dist/` output) and the source checkout (`packages/fullstack/commands`).
 * Falls back to `process.cwd()/packages/fullstack/commands` if neither
 * is reachable — for legacy script usage from the monorepo root.
 */
export function resolveShippedCommandsDir(): string {
	let moduleDir: string;
	try {
		moduleDir = dirname(fileURLToPath(import.meta.url));
	} catch {
		moduleDir = process.cwd();
	}
	const candidates: string[] = [
		// dist/index.js → dist/../commands
		resolve(moduleDir, "..", SHIPPED_COMMANDS_DIR),
		// dist/copy-commands.js → dist/../../commands
		resolve(moduleDir, "..", "..", SHIPPED_COMMANDS_DIR),
		// src/copy-commands.ts (source checkout) → src/../commands
		resolve(moduleDir, "..", SHIPPED_COMMANDS_DIR),
	];
	for (const dir of candidates) {
		if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
	}
	return resolve(process.cwd(), "packages", "fullstack", SHIPPED_COMMANDS_DIR);
}

/**
 * Copy a single shipped command directory into `targetRoot` (which is the
 * target `.omp/commands/` directory — NOT the project root).
 *
 * @param shippedRoot Absolute path to `packages/fullstack/commands/`.
 * @param name         The command name (subdirectory under `shippedRoot`).
 * @param targetRoot   Absolute path to the destination `.omp/commands/`.
 * @param mode         "overwrite" for install-time force-copy;
 *                     "skip-existing" for runtime auto-bootstrap.
 */
function copyCommandDir(
	shippedRoot: string,
	name: string,
	targetRoot: string,
	mode: "overwrite" | "skip-existing",
): "copied" | "skipped" {
	const src = join(shippedRoot, name);
	const dst = join(targetRoot, name);
	if (!existsSync(src) || !statSync(src).isDirectory()) return "skipped";

	if (!existsSync(dst)) mkdirSync(dst, { recursive: true });

	let copied = 0;
	const entries: Dirent[] = readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === "node_modules") continue;
		const s = join(src, entry.name);
		const d = join(dst, entry.name);
		if (entry.isDirectory()) {
			if (!existsSync(d)) mkdirSync(d, { recursive: true });
			// Recurse one level — enough for `<command>/_lib/*.ts`.
			const sub: Dirent[] = readdirSync(s, { withFileTypes: true });
			for (const subEntry of sub) {
				if (!subEntry.isFile()) continue;
				const ss = join(s, subEntry.name);
				const dd = join(d, subEntry.name);
				if (mode === "skip-existing" && existsSync(dd)) continue;
				try {
					copyFileSync(ss, dd);
					copied++;
				} catch {
					/* unreadable file — leave it for next session */
				}
			}
		} else if (entry.isFile()) {
			// `d` here targets the destination FILE, not a directory.
			if (mode === "skip-existing" && existsSync(d)) continue;
			try {
				copyFileSync(s, d);
				copied++;
			} catch {
				/* unreadable file */
			}
		}
	}

	return copied > 0 || mode === "overwrite" ? "copied" : "skipped";
}

function isAlreadyUpToDate(shippedRoot: string, name: string, targetRoot: string): boolean {
	const markers = ["index.ts", "index.js", "index.mjs", "index.cjs"];
	for (const marker of markers) {
		const shipped = join(shippedRoot, name, marker);
		const target = join(targetRoot, name, marker);
		if (!existsSync(shipped) || !existsSync(target)) continue;
		try {
			if (readFileSync(shipped, "utf8") === readFileSync(target, "utf8")) return true;
		} catch {
			/* unreadable — treat as out-of-date */
			return false;
		}
	}
	return false;
}

/**
 * Hard-copy shipped commands into the target. Used by `postinstall` and
 * the manual CLI script — overwrites existing files so reinstalls can
 * repair drift.
 */
export function copyCommandsForInstall(
	projectRoot: string,
	opts: CopyCommandsOptions = {},
): CopyCommandsResult {
	const shippedRoot = resolveShippedCommandsDir();
	const targetRoot = opts.targetDir
		? resolve(opts.targetDir)
		: resolve(projectRoot, ".omp", "commands");

	const result: CopyCommandsResult = { copied: [], skipped: [], errors: [] };
	if (!existsSync(shippedRoot) || !statSync(shippedRoot).isDirectory()) {
		result.errors.push(`shipped commands not found at ${shippedRoot}`);
		return result;
	}

	const entries: Dirent[] = readdirSync(shippedRoot, { withFileTypes: true });
	if (!existsSync(targetRoot)) mkdirSync(targetRoot, { recursive: true });

	const shippedNames: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		try {
			shippedNames.push(entry.name);
			const outcome = copyCommandDir(shippedRoot, entry.name, targetRoot, "overwrite");
			if (outcome === "copied") result.copied.push(entry.name);
			else result.skipped.push(entry.name);
		} catch (err) {
			result.errors.push(`${entry.name}: ${String(err)}`);
		}
	}
	// Converge to the shipped set: drop plugin-owned stale command dirs
	// (manifest-tracked or legacy shipped names), keep user-owned ones.
	pruneStaleCommands(targetRoot, shippedNames);
	return result;
}

/**
 * Best-effort auto-bootstrap: ensures a target project's `.omp/commands/`
 * has the shipped commands present, WITHOUT overwriting any user-modified
 * files. Designed to be invoked from the `session_start` extension hook
 * so the commands are present regardless of whether the user installed
 * via `npm install` (postinstall path) or `omp plugin install`
 * (extension-hook path).
 */
export function ensureCommandsForSession(
	projectRoot: string,
	opts: CopyCommandsOptions = {},
): CopyCommandsResult {
	const shippedRoot = resolveShippedCommandsDir();
	const targetRoot = opts.targetDir
		? resolve(opts.targetDir)
		: resolve(projectRoot, ".omp", "commands");

	const result: CopyCommandsResult = { copied: [], skipped: [], errors: [] };
	if (!existsSync(shippedRoot) || !statSync(shippedRoot).isDirectory()) {
		// Silently skip — don't break sessions when the shipped dir vanished.
		return result;
	}
	if (!existsSync(targetRoot)) {
		try {
			mkdirSync(targetRoot, { recursive: true });
		} catch {
			result.errors.push(`cannot create ${targetRoot}`);
			return result;
		}
	}

	const entries: Dirent[] = readdirSync(shippedRoot, { withFileTypes: true });
	const shippedNames: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		try {
			shippedNames.push(entry.name);
			if (isAlreadyUpToDate(shippedRoot, entry.name, targetRoot)) {
				result.skipped.push(entry.name);
				continue;
			}
			const outcome = copyCommandDir(shippedRoot, entry.name, targetRoot, "skip-existing");
			if (outcome === "copied") result.copied.push(entry.name);
			else result.skipped.push(entry.name);
		} catch (err) {
			result.errors.push(`${entry.name}: ${String(err)}`);
		}
	}
	// Every session start converges the target to the shipped set: stale
	// plugin-owned command dirs (team-next/team-yolo and other removed
	// shipped entries) stop being selectable once a fresh session starts.
	pruneStaleCommands(targetRoot, shippedNames);
	return result;
}
