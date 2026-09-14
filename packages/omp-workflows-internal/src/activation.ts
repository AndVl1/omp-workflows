/**
 * Workspace-marker activation gate.
 *
 * The bundle activates ONLY when the session project root carries ALL THREE
 * workspace markers: a `package.json` file plus `packages/core/` and
 * `packages/fullstack/` directories. Detection never keys off `.ts` file
 * extensions or any other heuristic; anything short of the full marker set
 * fails closed and callers must not claim owners or register tools.
 */

import { lstatSync, realpathSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";

export interface WorkspaceMarker {
	name: string;
	path: string;
	kind: "file" | "directory";
	/** Physical marker identity captured with lstat (symlinks never qualify). */
	dev: number;
	ino: number;
}

export type WorkspaceMarkerCheck =
	| { ok: true; markers: WorkspaceMarker[] }
	| { ok: false; code: "activation_markers_missing"; missing: WorkspaceMarker[] };

const REQUIRED_MARKERS: ReadonlyArray<{ name: string; kind: WorkspaceMarker["kind"] }> = [
	{ name: "package.json", kind: "file" },
	{ name: "packages/core", kind: "directory" },
	{ name: "packages/fullstack", kind: "directory" },
];

/** lstat every component so a symlinked parent cannot smuggle in a marker. */
function lstatPhysicalMarker(root: string, name: string): Stats {
	const segments = name.split("/");
	let cursor = root;
	let finalStats: Stats | undefined;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (!segment) throw new Error("workspace marker path is invalid");
		cursor = join(cursor, segment);
		const stats = lstatSync(cursor);
		if (stats.isSymbolicLink()) throw new Error("workspace marker path contains a symlink");
		if (index < segments.length - 1 && !stats.isDirectory()) throw new Error("workspace marker parent is not a directory");
		if (index === segments.length - 1) finalStats = stats;
	}
	if (!finalStats) throw new Error("workspace marker path is empty");
	return finalStats;
}

/**
 * Detect the workspace markers under `cwd` (resolved). Returns the observed
 * marker set on success, or the typed missing list on failure. Markers are
 * checked with lstat: a symlinked marker counts as missing (SEC-BUNDLE-002),
 * so activation requires the physical workspace layout.
 */
export function detectWorkspaceMarkers(cwd: string): WorkspaceMarkerCheck {
	const root = resolve(cwd);
	const missing: WorkspaceMarker[] = [];
	const observed: WorkspaceMarker[] = [];
	for (const marker of REQUIRED_MARKERS) {
		const path = join(root, marker.name);
		let stats: Stats | undefined;
		try {
			stats = lstatPhysicalMarker(root, marker.name);
		} catch {
			// Absent or unreadable marker counts as missing — fail closed.
		}
		const candidate = stats;
		const present = candidate !== undefined
			&& !candidate.isSymbolicLink()
			&& (marker.kind === "file" ? candidate.isFile() : candidate.isDirectory());
		if (!present) {
			missing.push({ name: marker.name, path, kind: marker.kind, dev: 0, ino: 0 });
			continue;
		}
		observed.push({ name: marker.name, path, kind: marker.kind, dev: candidate.dev, ino: candidate.ino });
	}
	if (missing.length > 0) return { ok: false, code: "activation_markers_missing", missing };
	return { ok: true, markers: observed };
}

export interface WorkspaceActivationSnapshot {
	/** The canonical physical project-root path used by owner provenance. */
	canonicalRoot: string;
	/** The canonical project-root identity, pinned across retained callbacks. */
	rootDev: number;
	rootIno: number;
	/** Marker identities accepted during the initial marked activation. */
	markers: readonly WorkspaceMarker[];
}

export type WorkspaceActivationSnapshotResult =
	| { ok: true; snapshot: WorkspaceActivationSnapshot }
	| { ok: false; code: "activation_markers_missing" | "activation_identity_changed"; missing?: WorkspaceMarker[] };

function inspectCanonicalRoot(cwd: string): { canonicalRoot: string; rootDev: number; rootIno: number } | undefined {
	try {
		const lexical = resolve(cwd);
		const lexicalStats = lstatSync(lexical);
		// A session root that is itself a symlink is not an accepted physical
		// workspace. Parent-directory aliases are harmless because the canonical
		// root identity below is what remains pinned.
		if (lexicalStats.isSymbolicLink() || !lexicalStats.isDirectory()) return undefined;
		const canonicalRoot = realpathSync(lexical);
		const canonicalStats = lstatSync(canonicalRoot);
		if (canonicalStats.isSymbolicLink() || !canonicalStats.isDirectory()) return undefined;
		return { canonicalRoot, rootDev: canonicalStats.dev, rootIno: canonicalStats.ino };
	} catch {
		return undefined;
	}
}

/** Capture the root and physical marker identities for the initial activation. */
export function captureWorkspaceActivation(cwd: string): WorkspaceActivationSnapshotResult {
	const gate = detectWorkspaceMarkers(cwd);
	if (!gate.ok) return gate;
	const root = inspectCanonicalRoot(cwd);
	if (!root) return { ok: false, code: "activation_markers_missing" };
	return { ok: true, snapshot: { ...root, markers: gate.markers } };
}

/**
 * Revalidate a retained activation before any owner claim, config write, or
 * tool transition. Every originally accepted physical marker must still be
 * the same identity; marker content below a directory does not affect this
 * gate, while marker replacement, deletion, and symlink substitution revoke
 * the activation.
 */
export function validateWorkspaceActivation(
	snapshot: WorkspaceActivationSnapshot,
	cwd: string,
): { ok: true } | { ok: false; code: "activation_markers_missing" | "activation_identity_changed" } {
	const gate = detectWorkspaceMarkers(cwd);
	if (!gate.ok) return { ok: false, code: gate.code };
	const root = inspectCanonicalRoot(cwd);
	if (!root
		|| root.canonicalRoot !== snapshot.canonicalRoot
		|| root.rootDev !== snapshot.rootDev
		|| root.rootIno !== snapshot.rootIno) {
		return { ok: false, code: "activation_identity_changed" };
	}
	if (gate.markers.length !== snapshot.markers.length) return { ok: false, code: "activation_identity_changed" };
	for (let index = 0; index < gate.markers.length; index += 1) {
		const current = gate.markers[index];
		const accepted = snapshot.markers[index];
		if (!current || !accepted
			|| current.name !== accepted.name
			|| current.kind !== accepted.kind
			|| current.dev !== accepted.dev
			|| current.ino !== accepted.ino) {
			return { ok: false, code: "activation_identity_changed" };
		}
	}
	return { ok: true };
}
