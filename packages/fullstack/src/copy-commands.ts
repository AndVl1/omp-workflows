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
 *  - {@link ensureCommandsForSession}: hash-aware conservative sync, used by
 *    the `session_start` extension hook. It updates files whose contents still
 *    match the previous shipped hash and preserves user customizations.
 *    Best-effort: errors are captured in the result but never thrown.
 *
 * OMP installs plugins into `~/.omp/plugins/`, which is OUTSIDE any
 * project's `node_modules`. As a result, the standard npm `postinstall`
 * hook never fires for `omp plugin install`. The `session_start` hook
 * covers that case: every time the user starts a session in a project,
 * missing commands and safe plugin updates land in `.omp/commands/`.
 */

import { createHash } from "node:crypto";
import { copyFileSync, Dirent, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHIPPED_COMMANDS_DIR = "commands";

/**
 * Manifest file written into `.omp/commands/` recording the command names
 * and hashes of the plugin materialized. A hash records the last shipped
 * content, allowing session sync to distinguish plugin updates from user
 * edits. The manifest is a plain JSON file, so OMP does not discover it as a
 * command.
 */
export const SHIPPED_MANIFEST_FILE = ".omp-shipped.json";

/**
 * Plugin-owned command directories that must not survive current-version sync.
 * Workflow entry points are registered synchronously by the extension; keeping
 * disk adapters makes OMP load duplicate commands and resolve package imports
 * relative to arbitrary consumer worktrees.
 */
export const LEGACY_REMOVED_COMMANDS = [
	"do-work",
	"team",
	"cto",
	"team-next",
	"team-yolo",
	"pulse",
	"coordinator-stats",
] as const;
const REMOVED_COMMAND_NAMES: Record<string, true> = Object.fromEntries(
	LEGACY_REMOVED_COMMANDS.map(name => [name, true] as const),
);

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
	schema: 2;
	shipped: string[];
	files: Record<string, string>;
}

interface ManifestSnapshot {
	shipped: string[];
	files: Record<string, string>;
}

function readHashMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const hashes: Record<string, string> = {};
	for (const [path, hash] of Object.entries(value)) {
		if (typeof hash === "string") hashes[path] = hash;
	}
	return hashes;
}

function readShippedManifest(targetRoot: string): ManifestSnapshot {
	try {
		const raw = JSON.parse(readFileSync(join(targetRoot, SHIPPED_MANIFEST_FILE), "utf8")) as {
			schema?: unknown;
			shipped?: unknown;
			files?: unknown;
		};
		const shipped = Array.isArray(raw.shipped)
			? raw.shipped.filter((name): name is string => typeof name === "string")
			: [];
		// Schema 1 tracked only directory names. Existing files are treated as
		// unknown and stay untouched until a force-copy establishes hashes.
		const files = raw.schema === 2 ? readHashMap(raw.files) : {};
		return { shipped, files };
	} catch {
		// missing/malformed manifest — nothing tracked yet
		return { shipped: [], files: {} };
	}
}

function writeShippedManifest(targetRoot: string, shipped: string[], files: Record<string, string> = {}): void {
	try {
		const manifest: ShippedManifest = { schema: 2, shipped, files };
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
 * with the current shipped set and file hashes. Returns the removed command
 * names.
 */
export function pruneStaleCommands(
	targetRoot: string,
	shippedNames: string[],
	fileHashes?: Record<string, string>,
): string[] {
	const manifest = readShippedManifest(targetRoot);
	const tracked = manifest.shipped;
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
	const hashes =
		fileHashes ??
		Object.fromEntries(
			Object.entries(manifest.files).filter(([path]) => shippedNames.includes(path.split("/")[0] ?? "")),
		);
	writeShippedManifest(targetRoot, shippedNames, hashes);
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
interface ShippedFile {
	sourcePath: string;
	targetPath: string;
	manifestPath: string;
}

function listShippedFiles(shippedRoot: string, name: string, targetRoot: string): ShippedFile[] {
	const sourceRoot = join(shippedRoot, name);
	if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) return [];
	const files: ShippedFile[] = [];
	const visit = (sourceDir: string, relativeDir: string): void => {
		for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const relativePath = join(relativeDir, entry.name);
			const sourcePath = join(sourceDir, entry.name);
			if (entry.isDirectory()) {
				visit(sourcePath, relativePath);
			} else if (entry.isFile()) {
				files.push({
					sourcePath,
					targetPath: join(targetRoot, name, relativePath),
					manifestPath: join(name, relativePath).split(sep).join("/"),
				});
			}
		}
	};
	visit(sourceRoot, "");
	return files;
}

function sha256File(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Copy a shipped command directory into `targetRoot`, overwriting every
 * shipped file. Used by the install-time force-copy path.
 */
function copyCommandDir(shippedRoot: string, name: string, targetRoot: string): "copied" | "skipped" {
	let copied = 0;
	for (const file of listShippedFiles(shippedRoot, name, targetRoot)) {
		try {
			mkdirSync(dirname(file.targetPath), { recursive: true });
			copyFileSync(file.sourcePath, file.targetPath);
			copied++;
		} catch {
			/* unreadable file — leave it for the next sync */
		}
	}
	return copied > 0 ? "copied" : "skipped";
}

interface SessionSyncResult {
	copied: boolean;
	hashes: Record<string, string>;
	errors: string[];
}

function syncCommandDirForSession(
	shippedRoot: string,
	name: string,
	targetRoot: string,
	previousHashes: Record<string, string>,
): SessionSyncResult {
	const result: SessionSyncResult = { copied: false, hashes: {}, errors: [] };
	for (const file of listShippedFiles(shippedRoot, name, targetRoot)) {
		try {
			const sourceHash = sha256File(file.sourcePath);
			if (!existsSync(file.targetPath)) {
				mkdirSync(dirname(file.targetPath), { recursive: true });
				copyFileSync(file.sourcePath, file.targetPath);
				result.copied = true;
				result.hashes[file.manifestPath] = sourceHash;
				continue;
			}

			const targetHash = sha256File(file.targetPath);
			const previousHash = previousHashes[file.manifestPath];
			if (targetHash === sourceHash) {
				result.hashes[file.manifestPath] = sourceHash;
			} else if (previousHash && targetHash === previousHash) {
				copyFileSync(file.sourcePath, file.targetPath);
				result.copied = true;
				result.hashes[file.manifestPath] = sourceHash;
			} else if (previousHash) {
				// The target diverged from both shipped versions: preserve the
				// user edit and retain the last known shipped baseline.
				result.hashes[file.manifestPath] = previousHash;
			}
		} catch (error) {
			result.errors.push(`${file.manifestPath}: ${String(error)}`);
		}
	}
	return result;
}

/**
 * Hard-copy shipped commands into the target. Used by `postinstall` and
 * the manual CLI script — overwrites existing files so reinstalls can
 * repair drift and records the resulting shipped hashes.
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
		if (!entry.isDirectory() || entry.name.startsWith(".") || REMOVED_COMMAND_NAMES[entry.name]) continue;
		try {
			shippedNames.push(entry.name);
			const outcome = copyCommandDir(shippedRoot, entry.name, targetRoot);
			if (outcome === "copied") result.copied.push(entry.name);
			else result.skipped.push(entry.name);
		} catch (err) {
			result.errors.push(`${entry.name}: ${String(err)}`);
		}
	}

	const fileHashes: Record<string, string> = {};
	for (const name of shippedNames) {
		for (const file of listShippedFiles(shippedRoot, name, targetRoot)) {
			try {
				fileHashes[file.manifestPath] = sha256File(file.sourcePath);
			} catch (error) {
				result.errors.push(`${file.manifestPath}: ${String(error)}`);
			}
		}
	}
	// Converge to the shipped set: drop plugin-owned stale command dirs
	// (manifest-tracked or legacy shipped names), keep user-owned ones.
	pruneStaleCommands(targetRoot, shippedNames, fileHashes);
	return result;
}

/**
 * Best-effort session sync. Each existing target file is overwritten only
 * when its hash matches the previous shipped hash; unknown or user-modified
 * files are preserved. Legacy schema-1 manifests have no hashes, so existing
 * files remain untouched until a force-copy establishes the baseline.
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

	const previousHashes = readShippedManifest(targetRoot).files;
	const fileHashes: Record<string, string> = {};
	const entries: Dirent[] = readdirSync(shippedRoot, { withFileTypes: true });
	const shippedNames: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || REMOVED_COMMAND_NAMES[entry.name]) continue;
		try {
			shippedNames.push(entry.name);
			const sync = syncCommandDirForSession(shippedRoot, entry.name, targetRoot, previousHashes);
			if (sync.copied) result.copied.push(entry.name);
			else result.skipped.push(entry.name);
			Object.assign(fileHashes, sync.hashes);
			result.errors.push(...sync.errors);
		} catch (err) {
			result.errors.push(`${entry.name}: ${String(err)}`);
		}
	}
	// Every session start converges the target to the shipped set: stale
	// plugin-owned command dirs (team-next/team-yolo and other removed
	// shipped entries) stop being selectable once a fresh session starts.
	pruneStaleCommands(targetRoot, shippedNames, fileHashes);
	return result;
}
