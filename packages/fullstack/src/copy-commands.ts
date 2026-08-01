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

import { copyFileSync, Dirent, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHIPPED_COMMANDS_DIR = "commands";

export interface CopyCommandsOptions {
	/** Override the target directory; defaults to `<cwd>/.omp/commands`. */
	targetDir?: string;
}

export interface CopyCommandsResult {
	copied: string[];
	skipped: string[];
	errors: string[];
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

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		try {
			const outcome = copyCommandDir(shippedRoot, entry.name, targetRoot, "overwrite");
			if (outcome === "copied") result.copied.push(entry.name);
			else result.skipped.push(entry.name);
		} catch (err) {
			result.errors.push(`${entry.name}: ${String(err)}`);
		}
	}
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
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		try {
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
	return result;
}
