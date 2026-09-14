import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	linkSync,
	unlinkSync,
	writeSync,
	type Stats,
} from "node:fs";
import { join, resolve } from "node:path";

/** The only project-local file that opts a project into fullstack ownership. */
export const FULLSTACK_ACTIVATION_MARKER_PATH = ".omp/fullstack.activation.json" as const;

// Property insertion order is part of the protocol. The bytes below are
// derived once from this single canonical value and are never re-serialized
// for writes after module initialization.
const FULLSTACK_ACTIVATION_MARKER_VALUE = Object.freeze({
	schema_version: 1,
	bundle_id: "@andvl1/omp-workflows-fullstack",
	entrypoint: "dist/index.js",
} as const);
const FULLSTACK_ACTIVATION_MARKER_TEXT = `${JSON.stringify(FULLSTACK_ACTIVATION_MARKER_VALUE)}\n`;

/** Exact marker bytes written by an explicit project bootstrap/enable action. */
export const FULLSTACK_ACTIVATION_MARKER_BYTES = Buffer.from(FULLSTACK_ACTIVATION_MARKER_TEXT, "utf8");
/** SHA-256 of {@link FULLSTACK_ACTIVATION_MARKER_BYTES}. */
export const FULLSTACK_ACTIVATION_MARKER_SHA256 = "c99eae69b1525e0baabe133091c93473baeaa2b7cf93c4252e26b7ab737f291c";

export type FullstackActivationMarker = typeof FULLSTACK_ACTIVATION_MARKER_VALUE;

const EXPECTED_KEYS = ["schema_version", "bundle_id", "entrypoint"] as const;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const MAX_MARKER_BYTES = FULLSTACK_ACTIVATION_MARKER_BYTES.byteLength;

function markerBytes(input: Uint8Array | string): Buffer {
	return typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
}

/**
 * Strictly parse marker bytes. Any byte difference (including key order,
 * whitespace, newline, duplicate JSON keys, or a UTF-8 replacement) rejects.
 * Invalid input returns null so extension load paths can fail closed without
 * creating or repairing a project marker.
 */
export function parseFullstackActivationMarker(
	input: Uint8Array | string,
): FullstackActivationMarker | null {
	const bytes = markerBytes(input);
	if (!bytes.equals(FULLSTACK_ACTIVATION_MARKER_BYTES)) return null;

	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== EXPECTED_KEYS.length || keys.some((key, index) => key !== EXPECTED_KEYS[index])) return null;
	if (record.schema_version !== FULLSTACK_ACTIVATION_MARKER_VALUE.schema_version
		|| record.bundle_id !== FULLSTACK_ACTIVATION_MARKER_VALUE.bundle_id
		|| record.entrypoint !== FULLSTACK_ACTIVATION_MARKER_VALUE.entrypoint) {
		return null;
	}
	return FULLSTACK_ACTIVATION_MARKER_VALUE;
}

function errnoCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function assertOwned(stats: Pick<Stats, "uid">, path: string): void {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && stats.uid !== uid) throw new Error(`activation marker path is not owned by the current user: ${path}`);
}

function canonicalProjectRoot(projectRoot: string): string {
	const lexical = resolve(projectRoot);
	const root = lstatSync(lexical);
	if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("activation marker project root is not a regular directory");
	const canonical = resolve(realpathSync(lexical));
	const canonicalStats = lstatSync(canonical);
	if (canonicalStats.isSymbolicLink() || !canonicalStats.isDirectory()) throw new Error("activation marker project root changed during validation");
	assertOwned(canonicalStats, canonical);
	return canonical;
}

function ensureMarkerParent(root: string): string {
	const parent = join(root, ".omp");
	try {
		const existing = lstatSync(parent);
		if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error("activation marker parent is not a regular directory");
		assertOwned(existing, parent);
	} catch (error) {
		if (errnoCode(error) !== "ENOENT") throw error;
		mkdirSync(parent, { mode: 0o700 });
		const created = lstatSync(parent);
		if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("activation marker parent changed during creation");
		assertOwned(created, parent);
	}
	return parent;
}

function readBoundedMarkerFile(path: string): Buffer | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
		const stats = fstatSync(fd);
		if (!stats.isFile()) throw new Error("activation marker destination is not a regular file");
		assertOwned(stats, path);
		const bytes = Buffer.allocUnsafe(MAX_MARKER_BYTES + 1);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const read = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
			if (read === 0) break;
			offset += read;
		}
		return bytes.subarray(0, offset);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function existingMarkerState(path: string): "missing" | "exact" | "conflict" {
	try {
		const named = lstatSync(path);
		if (named.isSymbolicLink() || !named.isFile()) throw new Error("activation marker destination is not a regular file");
		const bytes = readBoundedMarkerFile(path);
		return bytes?.equals(FULLSTACK_ACTIVATION_MARKER_BYTES) ? "exact" : "conflict";
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return "missing";
		throw error;
	}
}

/**
 * Validate the marker destination for an explicit installer without creating
 * the marker. A missing `.omp/` directory or marker is allowed; an existing
 * parent or marker must already be a safe, user-owned object. This preflight
 * lets an installer reject conflicts before mutating compatibility commands.
 */
export function validateFullstackActivationMarkerDestination(projectRoot: string): void {
	if (O_NOFOLLOW === 0 || O_NONBLOCK === 0) throw new Error("activation marker safe no-follow file operations are unavailable");
	const root = canonicalProjectRoot(projectRoot);
	const parent = join(root, ".omp");
	try {
		const parentStats = lstatSync(parent);
		if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) throw new Error("activation marker parent is not a regular directory");
		assertOwned(parentStats, parent);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return;
		throw error;
	}
	const target = join(root, FULLSTACK_ACTIVATION_MARKER_PATH);
	try {
		const targetStats = lstatSync(target);
		if (targetStats.isSymbolicLink() || !targetStats.isFile()) throw new Error("activation marker destination is not a regular file");
		const bytes = readBoundedMarkerFile(target);
		if (!bytes?.equals(FULLSTACK_ACTIVATION_MARKER_BYTES)) {
			throw new Error("activation marker conflict: existing bytes are not the canonical marker");
		}
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return;
		throw error;
	}
}

/**
 * Explicitly bootstrap/enable a project-local fullstack marker. This helper is
 * never called from extension loading or ordinary command/session paths.
 * Writes are private-temp + fsync + atomic non-overwriting link and never
 * follow links. An existing exact marker is an idempotent success; malformed
 * marker bytes are a conflict and are never silently overwritten.
 */
export function writeFullstackActivationMarker(projectRoot: string): void {
	if (O_NOFOLLOW === 0 || O_NONBLOCK === 0) throw new Error("activation marker safe no-follow file operations are unavailable");
	const root = canonicalProjectRoot(projectRoot);
	const parent = ensureMarkerParent(root);
	const target = join(root, FULLSTACK_ACTIVATION_MARKER_PATH);
	const state = existingMarkerState(target);
	if (state === "exact") return;
	if (state === "conflict") throw new Error("activation marker conflict: existing bytes are not the canonical marker");

	const temporary = join(parent, `.fullstack.activation.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_NONBLOCK, 0o600);
		let offset = 0;
		while (offset < FULLSTACK_ACTIVATION_MARKER_BYTES.byteLength) {
			const written = writeSync(fd, FULLSTACK_ACTIVATION_MARKER_BYTES, offset);
			if (written <= 0) throw new Error("activation marker write made no progress");
			offset += written;
		}
		fsyncSync(fd);
		fchmodSync(fd, 0o600);
		closeSync(fd);
		fd = undefined;
		// Atomically publish without replacing a marker that appeared after the
		// preflight. A concurrent exact marker is accepted; any other object
		// remains untouched and is reported as a conflict.
		try {
			linkSync(temporary, target);
		} catch (error) {
			if (errnoCode(error) !== "EEXIST") throw error;
			if (existingMarkerState(target) !== "exact") {
				throw new Error("activation marker conflict: existing bytes are not the canonical marker");
			}
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temporary);
		} catch (error) {
			if (errnoCode(error) !== "ENOENT") throw error;
		}
	}
}

/**
 * Read and validate the marker without creating or repairing anything.
 * Missing, malformed, symlinked, non-regular, or digest-mismatched files all
 * produce null (the owner layer maps this to `activation_markers_missing`).
 */
export function readFullstackActivationMarker(projectRoot: string): FullstackActivationMarker | null {
	if (O_NOFOLLOW === 0 || O_NONBLOCK === 0) return null;
	let root: string;
	try {
		root = canonicalProjectRoot(projectRoot);
	} catch {
		return null;
	}
	const target = join(root, FULLSTACK_ACTIVATION_MARKER_PATH);
	try {
		const bytes = readBoundedMarkerFile(target);
		if (!bytes || bytes.byteLength !== MAX_MARKER_BYTES) return null;
		if (createHash("sha256").update(bytes).digest("hex") !== FULLSTACK_ACTIVATION_MARKER_SHA256) return null;
		return parseFullstackActivationMarker(bytes);
	} catch {
		return null;
	}
}
