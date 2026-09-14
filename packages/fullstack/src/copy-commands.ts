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
 *    Overwrites existing files so a fresh install can repair drift. On a
 *    successful explicit install copy it also creates the canonical,
 *    project-local fullstack activation marker.
 *
 *  - {@link ensureCommandsForSession}: hash-aware conservative sync retained
 *    only for explicitly invoked legacy compatibility. It updates files whose
 *    contents still match the previous shipped hash and preserves user
 *    customizations. It never writes the fullstack activation marker.
 *    Best-effort: errors are captured in the result but never thrown.
 *
 * OMP installs plugins into `~/.omp/plugins/`, which is OUTSIDE any
 * project's `node_modules`. As a result, the standard npm `postinstall`
 * hook never fires for `omp plugin install`; callers requiring legacy
 * disk-discovery must invoke an explicit copy/bootstrap command.
 */

import { validateFullstackActivationMarkerDestination, writeFullstackActivationMarker } from "./activation-marker.js";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	fchmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

const MAX_COMMAND_FILE_BYTES = 1024 * 1024;
const MAX_COMMAND_FILES = 128;
const MAX_COMMAND_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFEST_ENTRIES = 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_DIRECTORY_NAME_BYTES = 255;
const MAX_DIRECTORY_SCAN_WORK = 1024 * 1024;

const MAX_DIRECTORY_DEPTH = 64;
export type CopyCommandsErrorCode =
	| "file_too_large"
	| "manifest_too_large"
	| "manifest_invalid_utf8"
	| "manifest_entries_too_many"
	| "manifest_invalid_entry"
	| "manifest_write_failed"
	| "stale_prune_failed"
	| "directory_scan_too_large"
	| "too_many_command_files"
	| "command_bytes_too_large";

class CopyCommandsError extends Error {
	constructor(readonly code: CopyCommandsErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "CopyCommandsError";
	}
}

function requireNoFollowFileFlags(): void {
	if (O_NOFOLLOW === 0 || O_NONBLOCK === 0) {
		throw new Error("platform lacks safe no-follow non-blocking file operations");
	}
}

function requireNoFollowDirectoryFlags(): void {
	if (O_NOFOLLOW === 0 || O_DIRECTORY === 0) {
		throw new Error("platform lacks safe no-follow directory operations");
	}
}

/**
 * Node's fs.renameSync only accepts pathname pairs, so a concurrently
 * replaced parent could redirect the rename. On POSIX, ask the platform
 * Python helper to create and rename relative to an inherited directory fd.
 * This is the same descriptor-relative primitive used by the core safe-FS
 * implementation and is fail-closed when unavailable.
 */
const DESCRIPTOR_REPLACE_HELPER = `
import base64, json, os, stat, sys

def stat_is_regular(info):
    return stat.S_ISREG(info.st_mode)

payload = json.load(sys.stdin)
target = payload["target"]
data = base64.b64decode(payload["data"])
parent = 3
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
temporary = "." + target + "." + payload["token"] + ".tmp"
fd = None
try:
    fd = os.open(temporary, flags, 0o600, dir_fd=parent)
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if written <= 0:
            raise OSError("short descriptor-relative write")
        offset += written
    os.fsync(fd)
    os.close(fd)
    fd = None
    try:
        existing = os.lstat(target, dir_fd=parent)
        if existing.st_uid != os.getuid():
            raise OSError("destination is not owned by the current user")
        if stat.S_ISLNK(existing.st_mode) or not stat_is_regular(existing):
            raise OSError("destination is not a regular file")
    except FileNotFoundError:
        pass
    os.replace(temporary, target, src_dir_fd=parent, dst_dir_fd=parent)
    try:
        os.fsync(parent)
    except OSError as exc:
        if exc.errno not in (22, 95):
            raise
finally:
    if fd is not None:
        os.close(fd)
    try:
        os.unlink(temporary, dir_fd=parent)
    except FileNotFoundError:
        pass
`;
const DESCRIPTOR_PRUNE_HELPER = `
import os, stat, sys

name = sys.stdin.read().strip()
parent = 3
MAX_ENTRIES = 4096
MAX_NAME_BYTES = 255
MAX_WORK = 1024 * 1024
MAX_DEPTH = 64

def check_name(entry_name, state):
    encoded = os.fsencode(entry_name)
    if len(encoded) > MAX_NAME_BYTES:
        raise OSError("stale command entry name exceeds safe length")
    state[0] += len(encoded) + 1
    state[1] += 1
    if state[1] > MAX_ENTRIES:
        raise OSError("stale command tree exceeds safe entry limit")
    if state[0] > MAX_WORK:
        raise OSError("stale command directory exceeds safe work budget")

def validate_tree(parent_fd, child_name, depth, state):
    if depth > MAX_DEPTH:
        raise OSError("stale command directory exceeds safe depth")
    initial = os.lstat(child_name, dir_fd=parent_fd)
    if initial.st_uid != os.getuid():
        raise OSError("stale command directory is not owned by the current user")
    if stat.S_ISLNK(initial.st_mode) or not stat.S_ISDIR(initial.st_mode):
        raise OSError("stale command directory is not a directory")
    child_fd = os.open(child_name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
    try:
        opened = os.fstat(child_fd)
        if opened.st_dev != initial.st_dev or opened.st_ino != initial.st_ino:
            raise OSError("stale command directory changed during validation")
        count = 0
        with os.scandir(child_fd) as directory:
            for entry in directory:
                count += 1
                if count > MAX_ENTRIES:
                    raise OSError("stale command directory exceeds safe entry limit")
                check_name(entry.name, state)
                entry_stat = entry.stat(follow_symlinks=False)
                if entry_stat.st_uid != os.getuid():
                    raise OSError("stale command entry is not owned by the current user")
                if stat.S_ISDIR(entry_stat.st_mode) and not stat.S_ISLNK(entry_stat.st_mode):
                    validate_tree(child_fd, entry.name, depth + 1, state)
    finally:
        os.close(child_fd)

def remove_tree(parent_fd, child_name, depth):
    if depth > MAX_DEPTH:
        raise OSError("stale command directory exceeds safe depth")
    initial = os.lstat(child_name, dir_fd=parent_fd)
    if initial.st_uid != os.getuid():
        raise OSError("stale command directory is not owned by the current user")
    if stat.S_ISLNK(initial.st_mode) or not stat.S_ISDIR(initial.st_mode):
        raise OSError("stale command directory is not a directory")
    child_fd = os.open(child_name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
    try:
        opened = os.fstat(child_fd)
        if opened.st_dev != initial.st_dev or opened.st_ino != initial.st_ino:
            raise OSError("stale command directory changed during prune")
        entries = []
        count = 0
        with os.scandir(child_fd) as directory:
            for entry in directory:
                count += 1
                if count > MAX_ENTRIES:
                    raise OSError("stale command directory exceeds safe entry limit")
                entries.append((entry.name, entry.stat(follow_symlinks=False)))
        for entry_name, entry_stat in entries:
            if stat.S_ISDIR(entry_stat.st_mode) and not stat.S_ISLNK(entry_stat.st_mode):
                remove_tree(child_fd, entry_name, depth + 1)
            else:
                os.unlink(entry_name, dir_fd=child_fd)
    finally:
        os.close(child_fd)
    final = os.lstat(child_name, dir_fd=parent_fd)
    if final.st_dev != initial.st_dev or final.st_ino != initial.st_ino:
        raise OSError("stale command directory changed before removal")
    os.rmdir(child_name, dir_fd=parent_fd)

state = [0, 0]
validate_tree(parent, name, 0, state)
remove_tree(parent, name, 0)
`;
const DESCRIPTOR_SCAN_HELPER = `
import json, os, stat, sys

payload = json.load(sys.stdin)
MAX_ENTRIES = int(payload["max_entries"])
MAX_NAME_BYTES = int(payload["max_name_bytes"])
MAX_WORK = int(payload["max_work"])
entries = []
work = 0
with os.scandir(3) as directory:
    for entry in directory:
        encoded = os.fsencode(entry.name)
        if len(encoded) > MAX_NAME_BYTES:
            raise OSError("directory entry name exceeds safe length")
        work += len(encoded) + 1
        if work > MAX_WORK:
            raise OSError("directory scan exceeds safe work budget")
        if len(entries) >= MAX_ENTRIES:
            raise OSError("directory exceeds safe entry limit")
        info = entry.stat(follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode):
            kind = "symlink"
        elif stat.S_ISDIR(info.st_mode):
            kind = "directory"
        elif stat.S_ISREG(info.st_mode):
            kind = "file"
        else:
            kind = "other"
        entries.append({"name": entry.name, "kind": kind})
sys.stdout.write(json.dumps(entries, separators=(",", ":")))
`;

function errnoCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}
function isWithinTree(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertOwned(info: { uid: number }, path: string): void {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && info.uid !== uid) throw new Error(`path is not owned by the current user: ${path}`);
}

function secureDirectoryComponent(path: string): void {
	requireNoFollowDirectoryFlags();
	const named = lstatSync(path);
	if (named.isSymbolicLink() || !named.isDirectory()) throw new Error(`directory component is unsafe: ${path}`);
	const fd = openSync(path, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (
			!opened.isDirectory()
			|| opened.dev !== named.dev
			|| opened.ino !== named.ino
			|| realpathSync(path) !== path
		) {
			throw new Error(`directory component changed during validation: ${path}`);
		}
		assertOwned(opened, path);
		if ((opened.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
	} finally {
		closeSync(fd);
	}
}

function secureOwnedFile(path: string, named: { dev: number; ino: number }): void {
	const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
			throw new Error(`destination changed during validation: ${path}`);
		}
		assertOwned(opened, path);
		// Never chmod a hard link: its inode may be shared with an unrelated
		// outside path. Atomic replacement below safely detaches such entries.
		if (opened.nlink === 1 && (opened.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
	} finally {
		closeSync(fd);
	}
}

/**
 * Resolve and create a command root without following a symlink at the root
 * itself or in any newly-created descendant. Existing ancestors may be
 * symlinked (for example, macOS's `/tmp`); the canonical ancestor is used as
 * the root for all subsequent operations.
 */
function ensureSafeDirectoryRoot(path: string): string {
	const absolute = resolve(path);
	const missing: string[] = [];
	let cursor = absolute;
	let base: string;
	for (;;) {
		try {
			const info = lstatSync(cursor);
			if (info.isSymbolicLink()) throw new Error(`directory root is a symlink: ${cursor}`);
			if (!info.isDirectory()) throw new Error(`directory root is not a directory: ${cursor}`);
			base = realpathSync(cursor);
			break;
		} catch (error) {
			if (errnoCode(error) !== "ENOENT") throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw new Error(`directory root has no existing ancestor: ${absolute}`);
			missing.unshift(basename(cursor));
			cursor = parent;
		}
	}

	let root = base;
	if (missing.length === 0) secureDirectoryComponent(root);
	for (const segment of missing) {
		root = join(root, segment);
		try {
			const info = lstatSync(root);
			if (info.isSymbolicLink()) throw new Error(`directory root contains a symlink: ${root}`);
			if (!info.isDirectory()) throw new Error(`directory root component is not a directory: ${root}`);
		} catch (error) {
			if (errnoCode(error) !== "ENOENT") throw error;
			mkdirSync(root, { mode: 0o700 });
		}
		secureDirectoryComponent(root);
	}
	return root;
}

function ensureSafeDestinationParent(root: string, targetPath: string): string {
	const parent = dirname(targetPath);
	if (!isWithinTree(root, parent)) throw new Error(`destination parent escapes command root: ${parent}`);
	let cursor = root;
	const rel = relative(root, parent);
	for (const segment of rel ? rel.split(sep) : []) {
		if (!segment || segment === "." || segment === "..") throw new Error(`unsafe destination parent: ${parent}`);
		cursor = join(cursor, segment);
		try {
			const info = lstatSync(cursor);
			if (info.isSymbolicLink()) throw new Error(`destination parent is a symlink: ${cursor}`);
			if (!info.isDirectory()) throw new Error(`destination parent is not a directory: ${cursor}`);
		} catch (error) {
			if (errnoCode(error) !== "ENOENT") throw error;
			mkdirSync(cursor, { mode: 0o700 });
		}
		secureDirectoryComponent(cursor);
	}
	return parent;
}

function readRegularFileNoFollow(
	filePath: string,
	maxBytes: number,
	tooLargeCode: "file_too_large" | "manifest_too_large" = "file_too_large",
): Buffer {
	requireNoFollowFileFlags();
	let fd: number | null = null;
	try {
		fd = openSync(filePath, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
		const info = fstatSync(fd);
		if (!info.isFile()) throw new Error(`not a regular file: ${filePath}`);
		if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > maxBytes) {
			throw new CopyCommandsError(tooLargeCode, `${filePath} exceeds ${maxBytes} bytes`);
		}

		// Read into a bounded buffer. A file can grow after fstat; the extra
		// byte detects that race without allocating unbounded input.
		const bytes = Buffer.allocUnsafe(maxBytes + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const read = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (read === 0) break;
			offset += read;
		}
		if (offset > maxBytes) throw new CopyCommandsError(tooLargeCode, `${filePath} exceeds ${maxBytes} bytes`);
		return bytes.subarray(0, offset);
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

function inspectDestination(targetPath: string): void {
	try {
		const info = lstatSync(targetPath);
		if (info.isSymbolicLink()) throw new Error(`destination is a symlink: ${targetPath}`);
		if (!info.isFile()) throw new Error(`destination is not a regular file: ${targetPath}`);
		secureOwnedFile(targetPath, info);
	} catch (error) {
		if (errnoCode(error) !== "ENOENT") throw error;
	}
}
function descriptorReplaceFile(parent: string, targetName: string, content: Buffer): void {
	requireNoFollowDirectoryFlags();
	const parentInfo = lstatSync(parent);
	if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
		throw new Error(`destination parent is not a directory: ${parent}`);
	}
	assertOwned(parentInfo, parent);
	const parentFd = openSync(parent, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
	try {
		const openedParent = fstatSync(parentFd);
		if (
			!openedParent.isDirectory()
			|| openedParent.dev !== parentInfo.dev
			|| openedParent.ino !== parentInfo.ino
			|| realpathSync(parent) !== parent
		) {
			throw new Error(`destination parent changed before replacement: ${parent}`);
		}
		assertOwned(openedParent, parent);
		const executable = process.platform === "darwin" ? "/usr/bin/python3" : "python3";
		const child = spawnSync(
			executable,
			["-I", "-c", DESCRIPTOR_REPLACE_HELPER],
			{
				input: JSON.stringify({
					target: targetName,
					token: randomUUID(),
					data: content.toString("base64"),
				}),
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe", parentFd],
				maxBuffer: 64 * 1024,
			},
		);
		if (child.error) throw child.error;
		if (child.status !== 0) {
			const stderr = typeof child.stderr === "string" ? child.stderr.trim() : "";
			throw new Error(`descriptor-relative replacement failed${stderr ? `: ${stderr}` : ""}`);
		}
	} finally {
		closeSync(parentFd);
	}
}

function descriptorPruneDirectory(root: string, name: string): void {
	requireNoFollowDirectoryFlags();
	const rootInfo = lstatSync(root);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`command root is not a directory: ${root}`);
	assertOwned(rootInfo, root);
	const rootFd = openSync(root, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
	try {
		const openedRoot = fstatSync(rootFd);
		if (
			!openedRoot.isDirectory()
			|| openedRoot.dev !== rootInfo.dev
			|| openedRoot.ino !== rootInfo.ino
			|| realpathSync(root) !== root
		) {
			throw new Error(`command root changed before prune: ${root}`);
		}
		const executable = process.platform === "darwin" ? "/usr/bin/python3" : "python3";
		const child = spawnSync(
			executable,
			["-I", "-c", DESCRIPTOR_PRUNE_HELPER],
			{
				input: name,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe", rootFd],
				maxBuffer: 64 * 1024,
			},
		);
		if (child.error) throw child.error;
		if (child.status !== 0) {
			const stderr = typeof child.stderr === "string" ? child.stderr.trim() : "";
			throw new Error(`descriptor-relative prune failed${stderr ? `: ${stderr}` : ""}`);
		}
	} finally {
		closeSync(rootFd);
	}
}


type SafeDirectoryEntryKind = "directory" | "file" | "symlink" | "other";
interface SafeDirectoryEntry {
	name: string;
	kind: SafeDirectoryEntryKind;
}

function descriptorReadDirectoryEntries(path: string): SafeDirectoryEntry[] {
	requireNoFollowDirectoryFlags();
	const named = lstatSync(path);
	if (named.isSymbolicLink() || !named.isDirectory()) {
		throw new Error(`directory scan target is not a directory: ${path}`);
	}
	const fd = openSync(path, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (
			!opened.isDirectory()
			|| opened.dev !== named.dev
			|| opened.ino !== named.ino
			|| realpathSync(path) !== path
		) {
			throw new Error(`directory scan target changed during validation: ${path}`);
		}
		const executable = process.platform === "darwin" ? "/usr/bin/python3" : "python3";
		const child = spawnSync(
			executable,
			["-I", "-c", DESCRIPTOR_SCAN_HELPER],
			{
				input: JSON.stringify({
					max_entries: MAX_DIRECTORY_ENTRIES,
					max_name_bytes: MAX_DIRECTORY_NAME_BYTES,
					max_work: MAX_DIRECTORY_SCAN_WORK,
				}),
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe", fd],
				maxBuffer: MAX_DIRECTORY_SCAN_WORK * 8,
			},
		);
		if (child.error) throw child.error;
		if (child.status !== 0 || typeof child.stdout !== "string") {
			const stderr = typeof child.stderr === "string" ? child.stderr.trim() : "";
			throw new Error(`bounded directory scan failed${stderr ? `: ${stderr}` : ""}`);
		}
		let raw: unknown;
		try {
			raw = JSON.parse(child.stdout);
		} catch (error) {
			throw new Error(`bounded directory scan returned invalid data: ${String(error)}`);
		}
		if (!Array.isArray(raw)) throw new Error("bounded directory scan returned invalid entries");
		const entries: SafeDirectoryEntry[] = [];
		let work = 0;
		for (const value of raw) {
			if (!value || typeof value !== "object") throw new Error("bounded directory scan returned an invalid entry");
			const candidate = value as { name?: unknown; kind?: unknown };
			if (typeof candidate.name !== "string" || typeof candidate.kind !== "string") {
				throw new Error("bounded directory scan returned an invalid entry");
			}
			const name = candidate.name;
			const nameBytes = Buffer.byteLength(name, "utf8");
			work += nameBytes + 1;
			if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")
				|| nameBytes > MAX_DIRECTORY_NAME_BYTES) {
				throw new Error("bounded directory scan returned an unsafe entry name");
			}
			if (work > MAX_DIRECTORY_SCAN_WORK || entries.length >= MAX_DIRECTORY_ENTRIES) {
				throw new Error("bounded directory scan exceeded its safe budget");
			}
			if (candidate.kind !== "directory" && candidate.kind !== "file"
				&& candidate.kind !== "symlink" && candidate.kind !== "other") {
				throw new Error("bounded directory scan returned an invalid entry kind");
			}
			entries.push({ name, kind: candidate.kind });
		}
		return entries;
	} finally {
		closeSync(fd);
	}
}
interface DirectoryScanBudget {
	entries: number;
	work: number;
}

function validateStaleTree(path: string, depth = 0, budget: DirectoryScanBudget = { entries: 0, work: 0 }): void {
	if (depth > MAX_DIRECTORY_DEPTH) throw new Error(`stale command directory exceeds safe depth: ${path}`);
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`stale command directory is not a directory: ${path}`);
	assertOwned(info, path);
	for (const entry of descriptorReadDirectoryEntries(path)) {
		budget.entries += 1;
		budget.work += Buffer.byteLength(entry.name, "utf8") + 1;
		if (budget.entries > MAX_DIRECTORY_ENTRIES || budget.work > MAX_DIRECTORY_SCAN_WORK) {
			throw new Error(`stale command directory exceeds safe scan budget: ${path}`);
		}
		const childPath = join(path, entry.name);
		const childInfo = lstatSync(childPath);
		assertOwned(childInfo, childPath);
		if (entry.kind === "symlink") {
			if (!childInfo.isSymbolicLink()) throw new Error(`stale command entry changed during validation: ${childPath}`);
			continue;
		}
		if (entry.kind === "directory") {
			if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) {
				throw new Error(`stale command entry changed during validation: ${childPath}`);
			}
			validateStaleTree(childPath, depth + 1, budget);
		} else if (entry.kind === "file") {
			if (!childInfo.isFile()) throw new Error(`stale command entry changed during validation: ${childPath}`);
		} else if (childInfo.isDirectory() || childInfo.isSymbolicLink()) {
			throw new Error(`stale command entry changed during validation: ${childPath}`);
		}
	}
}

function rejectUnsafeTrackedStaleEntries(targetRoot: string, shippedNames: readonly string[], trackedNames: readonly string[]): void {
	for (const entry of descriptorReadDirectoryEntries(targetRoot)) {
		if (entry.name.startsWith(".") || shippedNames.includes(entry.name)) continue;
		if (!trackedNames.includes(entry.name) && !LEGACY_REMOVED_COMMANDS.includes(entry.name as never)) continue;
		if (entry.kind !== "directory") {
			throw new Error("tracked stale command entry is not a safe directory: " + entry.name);
		}
		validateStaleTree(join(targetRoot, entry.name));
	}
}

/**
 * Atomically replace a regular destination with a private temporary file.
 * Rename replaces the directory entry rather than following a hard link, so
 * a destination hard-linked to an outside file cannot mutate that file.
 */
function replaceFileNoFollow(root: string, targetPath: string, content: Buffer): void {
	const parent = ensureSafeDestinationParent(root, targetPath);
	if (!isWithinTree(root, targetPath) || relative(root, targetPath) === "") {
		throw new Error(`destination escapes command root: ${targetPath}`);
	}
	descriptorReplaceFile(parent, basename(targetPath), content);
}


export type ShippedManifestWriter = (targetRoot: string, shipped: string[], files?: Record<string, string>) => void;

export interface PruneStaleCommandsOptions {
	/** Throw typed failures instead of retaining the prior best-effort behavior. */
	strict?: boolean;
	/** Override manifest persistence for deterministic failure injection. */
	writeManifest?: ShippedManifestWriter;
}

export interface CopyCommandsHooks {
	/** Override stale pruning for deterministic failure injection. */
	pruneStaleCommands?: typeof pruneStaleCommands;
	/** Override manifest persistence used by stale pruning. */
	writeManifest?: ShippedManifestWriter;
}

export interface CopyCommandsOptions {
	/** Override the target directory; defaults to `<cwd>/.omp/commands`. */
	targetDir?: string;
	hooks?: CopyCommandsHooks;
}

export type CopyCommandsFailureCode = CopyCommandsErrorCode | "copy_failed";

export interface CopyCommandsFailure {
	code: CopyCommandsFailureCode;
	message: string;
}

export interface CopyCommandsResult {
	copied: string[];
	skipped: string[];
	errors: string[];
	failure?: CopyCommandsFailure;
}

function recordCopyFailure(
	result: CopyCommandsResult,
	error: unknown,
	prefix: string,
	fallbackCode: CopyCommandsFailureCode = "copy_failed",
): void {
	const message = `${prefix}: ${String(error)}`;
	result.errors.push(message);
	if (!result.failure) {
		result.failure = {
			code: error instanceof CopyCommandsError ? error.code : fallbackCode,
			message,
		};
	}
}

function recordCopyErrors(
	result: CopyCommandsResult,
	errors: readonly string[],
	fallbackCode: CopyCommandsFailureCode = "copy_failed",
): void {
	if (errors.length === 0) return;
	result.errors.push(...errors);
	if (!result.failure) {
		result.failure = { code: fallbackCode, message: errors[0] ?? "copy command synchronization failed" };
	}
}

function toPruneFailure(
	error: unknown,
	context: string,
	code: CopyCommandsErrorCode = "stale_prune_failed",
): CopyCommandsError {
	if (error instanceof CopyCommandsError) return error;
	return new CopyCommandsError(code, `${context}: ${String(error)}`);
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
	let text: string;
	try {
		const bytes = readRegularFileNoFollow(
			join(targetRoot, SHIPPED_MANIFEST_FILE),
			MAX_MANIFEST_BYTES,
			"manifest_too_large",
		);
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			throw new CopyCommandsError("manifest_invalid_utf8", `manifest is not valid UTF-8: ${String(error)}`);
		}
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return { shipped: [], files: {} };
		throw error;
	}
	let raw: { schema?: unknown; shipped?: unknown; files?: unknown };
	try {
		raw = JSON.parse(text) as { schema?: unknown; shipped?: unknown; files?: unknown };
	} catch {
		// malformed JSON manifest — nothing tracked yet
		return { shipped: [], files: {} };
	}
	if (Array.isArray(raw.shipped) && raw.shipped.length > MAX_MANIFEST_ENTRIES) {
		throw new CopyCommandsError("manifest_entries_too_many", `manifest tracks more than ${MAX_MANIFEST_ENTRIES} commands`);
	}
	const shipped = Array.isArray(raw.shipped)
		? raw.shipped.filter((name): name is string => typeof name === "string")
		: [];
	if (shipped.some((name) => name.length === 0 || name === "." || name === ".." || name.includes("/") || Buffer.byteLength(name, "utf8") > MAX_DIRECTORY_NAME_BYTES)) {
		throw new CopyCommandsError("manifest_invalid_entry", "manifest contains an unsafe shipped command name");
	}
	if (raw.files && typeof raw.files === "object" && !Array.isArray(raw.files)
		&& Object.keys(raw.files).length > MAX_MANIFEST_ENTRIES) {
		throw new CopyCommandsError("manifest_entries_too_many", `manifest tracks more than ${MAX_MANIFEST_ENTRIES} files`);
	}
	// Schema 1 tracked only directory names. Existing files are treated as
	// unknown and stay untouched until a force-copy establishes hashes.
	const files = raw.schema === 2 ? readHashMap(raw.files) : {};
	return { shipped, files };
}

function writeShippedManifest(targetRoot: string, shipped: string[], files: Record<string, string> = {}): void {
	try {
		const manifest: ShippedManifest = { schema: 2, shipped, files };
		const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		if (content.length > MAX_MANIFEST_BYTES) {
			throw new CopyCommandsError("manifest_too_large", `manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
		}
		replaceFileNoFollow(targetRoot, join(targetRoot, SHIPPED_MANIFEST_FILE), content);
	} catch (error) {
		if (error instanceof CopyCommandsError) throw error;
		throw new CopyCommandsError("manifest_write_failed", `manifest write failed: ${String(error)}`);
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
	options: PruneStaleCommandsOptions = {},
): string[] {
	let safeRoot: string;
	try {
		const requestedRoot = resolve(targetRoot);
		const info = lstatSync(requestedRoot);
		if (info.isSymbolicLink() || !info.isDirectory()) return [];
		safeRoot = realpathSync(requestedRoot);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return [];
		if (!options.strict) return [];
		throw toPruneFailure(error, "cannot resolve stale command root");
	}
	try {
		secureDirectoryComponent(safeRoot);
	} catch (error) {
		if (!options.strict) return [];
		throw toPruneFailure(error, "cannot validate stale command root");
	}
	let manifest: ManifestSnapshot;
	try {
		manifest = readShippedManifest(safeRoot);
	} catch (error) {
		if (!options.strict) return [];
		throw toPruneFailure(error, "cannot read stale command manifest");
	}
	const tracked = manifest.shipped;
	const legacy = LEGACY_REMOVED_COMMANDS as readonly string[];
	const removed: string[] = [];
	let entries: SafeDirectoryEntry[];
	try {
		entries = descriptorReadDirectoryEntries(safeRoot);
	} catch (error) {
		if (!options.strict) return removed;
		throw toPruneFailure(error, "cannot scan stale command root");
	}
	const staleNames: string[] = [];
	for (const entry of entries) {
		if (entry.kind !== "directory" || entry.name.startsWith(".")) continue;
		if (shippedNames.includes(entry.name)) continue;
		if (!tracked.includes(entry.name) && !legacy.includes(entry.name)) continue;
		try {
			const stalePath = join(safeRoot, entry.name);
			const info = lstatSync(stalePath);
			if (info.isSymbolicLink() || !info.isDirectory()) continue;
			assertOwned(info, stalePath);
			validateStaleTree(stalePath);
			staleNames.push(entry.name);
		} catch (error) {
			// Validate every stale tree before deleting any of them.
			if (!options.strict) return removed;
			throw toPruneFailure(error, `cannot validate stale command ${entry.name}`);
		}
	}
	for (const name of staleNames) {
		try {
			descriptorPruneDirectory(safeRoot, name);
			removed.push(name);
		} catch (error) {
			// A concurrent replacement is retried on the next session.
			if (!options.strict) return removed;
			throw toPruneFailure(error, `cannot prune stale command ${name}`);
		}
	}
	const hashes =
		fileHashes ??
		Object.fromEntries(
			Object.entries(manifest.files).filter(([path]) => shippedNames.includes(path.split("/")[0] ?? "")),
		);
	try {
		(options.writeManifest ?? writeShippedManifest)(safeRoot, shippedNames, hashes);
	} catch (error) {
		if (!options.strict) return removed;
		throw toPruneFailure(error, "cannot write shipped command manifest", "manifest_write_failed");
	}
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
		try {
			const info = lstatSync(dir);
			if (!info.isSymbolicLink() && info.isDirectory()) return dir;
		} catch {
			// Try the next package layout candidate.
		}
	}
	return resolve(process.cwd(), "packages", "fullstack", SHIPPED_COMMANDS_DIR);
}
interface ShippedFile {
	sourcePath: string;
	targetPath: string;
	manifestPath: string;
	size: number;
}

function listShippedFiles(shippedRoot: string, name: string, targetRoot: string): ShippedFile[] {
	const sourceRoot = join(shippedRoot, name);
	let sourceRootInfo;
	try {
		sourceRootInfo = lstatSync(sourceRoot);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return [];
		throw error;
	}
	if (sourceRootInfo.isSymbolicLink()) throw new Error(`shipped command is a symlink: ${sourceRoot}`);
	if (!sourceRootInfo.isDirectory()) throw new Error(`shipped command is not a directory: ${sourceRoot}`);
	const canonicalShippedRoot = realpathSync(shippedRoot);
	const canonicalSourceRoot = realpathSync(sourceRoot);
	if (!isWithinTree(canonicalShippedRoot, canonicalSourceRoot)) {
		throw new Error(`shipped command escapes package root: ${sourceRoot}`);
	}

	const files: ShippedFile[] = [];
	let fileCount = 0;
	let scannedEntries = 0;
	let scannedWork = 0;
	let totalBytes = 0;
	const visit = (sourceDir: string, relativeDir: string): void => {
		for (const entry of descriptorReadDirectoryEntries(sourceDir)) {
			scannedEntries += 1;
			scannedWork += Buffer.byteLength(entry.name, "utf8") + 1;
			if (scannedEntries > MAX_DIRECTORY_ENTRIES || scannedWork > MAX_DIRECTORY_SCAN_WORK) {
				throw new CopyCommandsError("directory_scan_too_large", `${sourceRoot} exceeds safe directory scan budget`);
			}
			const relativePath = join(relativeDir, entry.name);
			const sourcePath = join(sourceDir, entry.name);
			const info = lstatSync(sourcePath);
			if (info.isSymbolicLink() || entry.kind === "symlink") {
				throw new Error(`shipped command entry is a symlink: ${sourcePath}`);
			}
			if (entry.name === "node_modules") continue;
			if (entry.kind === "directory") {
				visit(sourcePath, relativePath);
			} else if (entry.kind === "file") {
				if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_COMMAND_FILE_BYTES) {
					throw new CopyCommandsError("file_too_large", `${sourcePath} exceeds ${MAX_COMMAND_FILE_BYTES} bytes`);
				}
				fileCount += 1;
				if (fileCount > MAX_COMMAND_FILES) {
					throw new CopyCommandsError("too_many_command_files", `${sourceRoot} exceeds ${MAX_COMMAND_FILES} files`);
				}
				totalBytes += info.size;
				if (totalBytes > MAX_COMMAND_TOTAL_BYTES) {
					throw new CopyCommandsError("command_bytes_too_large", `${sourceRoot} exceeds ${MAX_COMMAND_TOTAL_BYTES} bytes`);
				}
				files.push({
					sourcePath,
					targetPath: join(targetRoot, name, relativePath),
					manifestPath: join(name, relativePath).split(sep).join("/"),
					size: info.size,
				});
			} else {
				throw new Error(`shipped command entry is not a regular file: ${sourcePath}`);
			}
		}
	};
	visit(canonicalSourceRoot, "");
	return files;
}
function preflightShippedCommands(
	shippedRoot: string,
	entries: SafeDirectoryEntry[],
	targetRoot: string,
): { names: string[]; errors: string[] } {
	const names: string[] = [];
	const errors: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || REMOVED_COMMAND_NAMES[entry.name]) continue;
		if (entry.kind === "symlink") {
			errors.push(`${entry.name}: shipped command is a symlink`);
			continue;
		}
		if (entry.kind !== "directory") continue;
		try {
			listShippedFiles(shippedRoot, entry.name, targetRoot);
			names.push(entry.name);
		} catch (error) {
			errors.push(`${entry.name}: ${String(error)}`);
		}
	}
	return { names, errors };
}

function sha256File(filePath: string, maxBytes: number): string {
	return createHash("sha256").update(readRegularFileNoFollow(filePath, maxBytes)).digest("hex");
}

/**
 * Copy a shipped command directory into `targetRoot`, overwriting every
 * shipped file. Used by the install-time force-copy path.
 */
function copyCommandDir(shippedRoot: string, name: string, targetRoot: string): "copied" | "skipped" {
	let copied = 0;
	for (const file of listShippedFiles(shippedRoot, name, targetRoot)) {
		replaceFileNoFollow(targetRoot, file.targetPath, readRegularFileNoFollow(file.sourcePath, MAX_COMMAND_FILE_BYTES));
		copied++;
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
	let files: ShippedFile[];
	try {
		files = listShippedFiles(shippedRoot, name, targetRoot);
	} catch (error) {
		result.errors.push(`${name}: ${String(error)}`);
		return result;
	}
	for (const file of files) {
		try {
			ensureSafeDestinationParent(targetRoot, file.targetPath);
			const sourceHash = sha256File(file.sourcePath, MAX_COMMAND_FILE_BYTES);
			let targetExists = true;
			try {
				lstatSync(file.targetPath);
			} catch (error) {
				if (errnoCode(error) !== "ENOENT") throw error;
				targetExists = false;
			}
			if (!targetExists) {
				replaceFileNoFollow(targetRoot, file.targetPath, readRegularFileNoFollow(file.sourcePath, MAX_COMMAND_FILE_BYTES));
				result.copied = true;
				result.hashes[file.manifestPath] = sourceHash;
				continue;
			}

			inspectDestination(file.targetPath);
			const targetHash = sha256File(file.targetPath, MAX_COMMAND_FILE_BYTES);
			const previousHash = previousHashes[file.manifestPath];
			if (targetHash === sourceHash) {
				result.hashes[file.manifestPath] = sourceHash;
			} else if (previousHash && targetHash === previousHash) {
				replaceFileNoFollow(targetRoot, file.targetPath, readRegularFileNoFollow(file.sourcePath, MAX_COMMAND_FILE_BYTES));
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
	const result: CopyCommandsResult = { copied: [], skipped: [], errors: [] };
	try {
		// Marker conflicts are rejected before any compatibility command
		// destination is inspected or mutated. A missing marker remains
		// allowed until the successful-copy commit below.
		validateFullstackActivationMarkerDestination(projectRoot);
	} catch (error) {
		recordCopyFailure(result, error, "unsafe fullstack activation marker");
		return result;
	}

	let shippedRoot: string;
	try {
		shippedRoot = resolveShippedCommandsDir();
		const info = lstatSync(shippedRoot);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`shipped commands root is unsafe: ${shippedRoot}`);
		shippedRoot = realpathSync(shippedRoot);
	} catch (error) {
		result.errors.push(`shipped commands not found at ${resolveShippedCommandsDir()}: ${String(error)}`);
		return result;
	}

	let targetRoot: string;
	let manifest: ManifestSnapshot;
	try {
		const requestedRoot = opts.targetDir
			? resolve(opts.targetDir)
			: join(realpathSync(resolve(projectRoot)), ".omp", "commands");
		targetRoot = ensureSafeDirectoryRoot(requestedRoot);
	} catch (error) {
		result.errors.push(`unsafe command destination: ${String(error)}`);
		return result;
	}
	try {
		manifest = readShippedManifest(targetRoot);
	} catch (error) {
		recordCopyFailure(result, error, "unsafe shipped manifest");
		return result;
	}

	try {
		descriptorReadDirectoryEntries(targetRoot);
	} catch (error) {
		recordCopyFailure(result, error, "cannot scan command destination");
		return result;
	}
	let entries: SafeDirectoryEntry[];
	try {
		entries = descriptorReadDirectoryEntries(shippedRoot);
	} catch (error) {
		recordCopyFailure(result, error, `cannot read shipped commands at ${shippedRoot}`);
		return result;
	}
	const preflight = preflightShippedCommands(shippedRoot, entries, targetRoot);
	if (preflight.errors.length > 0) {
		recordCopyErrors(result, preflight.errors);
		return result;
	}
	const shippedNames = preflight.names;
	try {
		rejectUnsafeTrackedStaleEntries(targetRoot, shippedNames, manifest.shipped);
	} catch (error) {
		result.errors.push("unsafe stale command destination: " + String(error));
		return result;
	}

	for (const name of shippedNames) {
		try {
			const outcome = copyCommandDir(shippedRoot, name, targetRoot);
			if (outcome === "copied") result.copied.push(name);
			else result.skipped.push(name);
		} catch (error) {
			result.errors.push(`${name}: ${String(error)}`);
		}
	}

	const fileHashes: Record<string, string> = {};
	for (const name of shippedNames) {
		try {
			for (const file of listShippedFiles(shippedRoot, name, targetRoot)) {
				try {
					fileHashes[file.manifestPath] = sha256File(file.sourcePath, MAX_COMMAND_FILE_BYTES);
				} catch (error) {
					result.errors.push(`${file.manifestPath}: ${String(error)}`);
				}
			}
		} catch (error) {
			result.errors.push(`${name}: ${String(error)}`);
		}
	}
	// Converge to the shipped set: drop plugin-owned stale command dirs
	// (manifest-tracked or legacy shipped names), keep user-owned ones.
	try {
		const prune = opts.hooks?.pruneStaleCommands ?? pruneStaleCommands;
		prune(targetRoot, shippedNames, fileHashes, { strict: true, writeManifest: opts.hooks?.writeManifest });
	} catch (error) {
		recordCopyFailure(result, error, "stale command prune failed", "stale_prune_failed");
	}
	if (result.errors.length === 0) {
		try {
			// The marker is the final installer commit: a failed copy never
			// opts the project into fullstack ownership.
			writeFullstackActivationMarker(projectRoot);
		} catch (error) {
			recordCopyFailure(result, error, "fullstack activation marker write failed");
		}
	}

	return result;
}

export function ensureCommandsForSession(
	projectRoot: string,
	opts: CopyCommandsOptions = {},
): CopyCommandsResult {
	const result: CopyCommandsResult = { copied: [], skipped: [], errors: [] };
	let shippedRoot: string;
	try {
		shippedRoot = resolveShippedCommandsDir();
		const info = lstatSync(shippedRoot);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`shipped commands root is unsafe: ${shippedRoot}`);
		shippedRoot = realpathSync(shippedRoot);
	} catch (error) {
		recordCopyFailure(result, error, "shipped commands unavailable");
		return result;
	}

	let targetRoot: string;
	try {
		const requestedRoot = opts.targetDir
			? resolve(opts.targetDir)
			: join(realpathSync(resolve(projectRoot)), ".omp", "commands");
		targetRoot = ensureSafeDirectoryRoot(requestedRoot);
	} catch (error) {
		recordCopyFailure(result, error, "cannot create a safe command destination");
		return result;
	}

	let previousHashes: Record<string, string>;
	try {
		previousHashes = readShippedManifest(targetRoot).files;
	} catch (error) {
		recordCopyFailure(result, error, "unsafe shipped manifest");
		return result;
	}
	try {
		descriptorReadDirectoryEntries(targetRoot);
	} catch (error) {
		recordCopyFailure(result, error, "cannot scan command destination");
		return result;
	}
	const fileHashes: Record<string, string> = {};
	let entries: SafeDirectoryEntry[];
	try {
		entries = descriptorReadDirectoryEntries(shippedRoot);
	} catch (error) {
		recordCopyFailure(result, error, `cannot read shipped commands at ${shippedRoot}`);
		return result;
	}
	const preflight = preflightShippedCommands(shippedRoot, entries, targetRoot);
	if (preflight.errors.length > 0) {
		recordCopyErrors(result, preflight.errors);
		return result;
	}
	const shippedNames = preflight.names;
	for (const name of shippedNames) {
		try {
			const sync = syncCommandDirForSession(shippedRoot, name, targetRoot, previousHashes);
			if (sync.copied) result.copied.push(name);
			else result.skipped.push(name);
			Object.assign(fileHashes, sync.hashes);
			recordCopyErrors(result, sync.errors);
		} catch (error) {
			recordCopyFailure(result, error, name);
		}
	}
	// Every session start converges the target to the shipped set: stale
	// plugin-owned command dirs (team-next/team-yolo and other removed
	// shipped entries) stop being selectable once a fresh session starts.
	try {
		const prune = opts.hooks?.pruneStaleCommands ?? pruneStaleCommands;
		prune(targetRoot, shippedNames, fileHashes, { strict: true, writeManifest: opts.hooks?.writeManifest });
	} catch (error) {
		recordCopyFailure(result, error, "stale command prune failed", "stale_prune_failed");
	}
	return result;
}
