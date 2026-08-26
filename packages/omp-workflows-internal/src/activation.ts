/**
 * Workspace-marker activation gate.
 *
 * The bundle activates ONLY when the session project root carries ALL THREE
 * workspace markers: a `package.json` file plus `packages/core/` and
 * `packages/fullstack/` directories. Detection never keys off `.ts` file
 * extensions or any other heuristic; anything short of the full marker set
 * fails closed and callers must not claim owners or register tools.
 */

import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorkspaceMarker {
	name: string;
	path: string;
	kind: "file" | "directory";
}

export type WorkspaceMarkerCheck =
	| { ok: true; markers: WorkspaceMarker[] }
	| { ok: false; code: "activation_markers_missing"; missing: WorkspaceMarker[] };

const REQUIRED_MARKERS: ReadonlyArray<{ name: string; kind: WorkspaceMarker["kind"] }> = [
	{ name: "package.json", kind: "file" },
	{ name: "packages/core", kind: "directory" },
	{ name: "packages/fullstack", kind: "directory" },
];

/**
 * Detect the workspace markers under `cwd` (resolved). Returns the observed
 * marker set on success, or the typed missing list on failure. Markers are
 * checked with lstat: a symlinked marker counts as missing (SEC-BUNDLE-002),
 * so activation requires the physical workspace layout.
 */
export function detectWorkspaceMarkers(cwd: string): WorkspaceMarkerCheck {
	const root = resolve(cwd);
	const missing: WorkspaceMarker[] = [];
	for (const marker of REQUIRED_MARKERS) {
		let present = false;
		try {
			const stats = lstatSync(join(root, marker.name));
			present = marker.kind === "file" ? stats.isFile() : stats.isDirectory();
		} catch {
			// Absent or unreadable marker counts as missing — fail closed.
		}
		if (!present) missing.push({ name: marker.name, path: join(root, marker.name), kind: marker.kind });
	}
	if (missing.length > 0) return { ok: false, code: "activation_markers_missing", missing };
	return {
		ok: true,
		markers: REQUIRED_MARKERS.map((marker) => ({
			name: marker.name,
			path: join(root, marker.name),
			kind: marker.kind,
		})),
	};
}
