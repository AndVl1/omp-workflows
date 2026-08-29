/**
 * Workspace-marker admission input for the private provider.
 *
 * Marker files are repository data and cannot authorize publication by
 * themselves.  The host must first issue an opaque capability containing a
 * descriptor-relative root pin.  Detection only uses that retained pin and
 * the factory-issued filesystem authority; a path supplied by a caller is
 * never resolved or read here.
 */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import {
	createCanonicalRoot,
	isTrustedFsAuthority,
	type CanonicalRoot,
	type FsDirectoryHandle,
	type FsEntryIdentity,
	type FsRootDirectory,
	type TrustedFsAuthority,
} from "@andvl1/omp-workflows-core";

export interface WorkspaceMarker {
	readonly name: string;
	readonly kind: "file" | "directory";
}

export type WorkspaceMarkerCheck =
	| { readonly ok: true; readonly markers: readonly WorkspaceMarker[] }
	| { readonly ok: false; readonly code: "activation_markers_missing"; readonly missing: readonly WorkspaceMarker[] };

/**
 * Opaque root/marker capability.  The runtime witness is retained in a
 * private WeakMap, so structural lookalikes and repository paths cannot pass
 * the marker gate.
 */
declare const workspaceMarkerCapabilityBrand: unique symbol;
export interface WorkspaceMarkerCapability {
	readonly [workspaceMarkerCapabilityBrand]: "WorkspaceMarkerCapability";
}

const REQUIRED_MARKERS: readonly WorkspaceMarker[] = Object.freeze([
	Object.freeze({ name: "package.json", kind: "file" as const }),
	Object.freeze({ name: "packages/core", kind: "directory" as const }),
	Object.freeze({ name: "packages/fullstack", kind: "directory" as const }),
]);

interface WorkspaceMarkerWitness {
	readonly root: CanonicalRoot;
	readonly authority: TrustedFsAuthority;
	readonly pinnedRoot: FsRootDirectory;
}

const issuedWorkspaceMarkerCapabilities = new WeakMap<object, WorkspaceMarkerWitness>();

function missingMarkers(): WorkspaceMarkerCheck {
	return {
		ok: false,
		code: "activation_markers_missing",
		missing: Object.freeze(REQUIRED_MARKERS.map((marker) => Object.freeze({ ...marker }))),
	};
}

function inspect(
	authority: TrustedFsAuthority,
	directory: FsDirectoryHandle,
	leaf: string,
): FsEntryIdentity | null {
	try {
		const result = authority.inspect(directory, leaf);
		return result.ok ? result.value : null;
	} catch {
		return null;
	}
}

function openDirectory(
	authority: TrustedFsAuthority,
	directory: FsDirectoryHandle,
	leaf: string,
): FsDirectoryHandle | null {
	try {
		const result = authority.openDirectory(directory, leaf);
		return result.ok ? result.value : null;
	} catch {
		return null;
	}
}

function matches(entry: FsEntryIdentity | null, kind: WorkspaceMarker["kind"]): boolean {
	return entry !== null && entry.kind === kind;
}

/**
 * Detect the markers through one host-pinned root descriptor.  A missing,
 * unsupported, foreign or malformed authority result is indistinguishable
 * from a missing marker and fails closed before publication.
 */
export function detectWorkspaceMarkers(capability: WorkspaceMarkerCapability): WorkspaceMarkerCheck {
	const witness = capability !== null && typeof capability === "object"
		? issuedWorkspaceMarkerCapabilities.get(capability as object)
		: undefined;
	if (!witness) return missingMarkers();
	try {
		if (witness.pinnedRoot.canonicalRoot !== witness.root) return missingMarkers();

		const rootDirectory = witness.pinnedRoot.rootDirectory;
		const packageJson = matches(inspect(witness.authority, rootDirectory, "package.json"), "file");
		const packagesDirectory = openDirectory(witness.authority, rootDirectory, "packages");
		const core = matches(
			packagesDirectory === null ? null : inspect(witness.authority, packagesDirectory, "core"),
			"directory",
		);
		const fullstack = matches(
			packagesDirectory === null ? null : inspect(witness.authority, packagesDirectory, "fullstack"),
			"directory",
		);

		const present = [packageJson, core, fullstack];
		const missing = REQUIRED_MARKERS.filter((_marker, index) => !present[index]);
		if (missing.length > 0) {
			return {
				ok: false,
				code: "activation_markers_missing",
				missing: Object.freeze(missing.map((marker) => Object.freeze({ ...marker }))),
			};
		}
		return {
			ok: true,
			markers: Object.freeze(REQUIRED_MARKERS.map((marker) => Object.freeze({ ...marker }))),
		};
	} catch {
		return missingMarkers();
	}
}

/**
 * Return the root retained by a valid marker capability.  This is a
 * capability witness accessor, not path canonicalization or filesystem I/O.
 */
export function workspaceMarkerRoot(capability: WorkspaceMarkerCapability): CanonicalRoot | undefined {
	const witness = capability !== null && typeof capability === "object"
		? issuedWorkspaceMarkerCapabilities.get(capability as object)
		: undefined;
	return witness?.root;
}

/**
 * Test-only seam.  It is intentionally omitted from the package barrel; the
 * production launcher must receive a host-issued capability instead.
 */
export function createTestWorkspaceMarkerCapability(
	root: string,
	authority: TrustedFsAuthority,
): WorkspaceMarkerCapability {
	const canonicalRoot = createCanonicalRoot(root);
	if (!canonicalRoot) throw new TypeError("test marker capability requires a canonical absolute root");
	if (!isTrustedFsAuthority(authority) || typeof authority.openRootDirectory !== "function") {
		throw new TypeError("test marker capability requires a factory-issued root authority");
	}
	const opened = authority.openRootDirectory.call(authority, canonicalRoot);
	if (!opened.ok) throw new Error(`cannot pin test workspace root: ${opened.reason}`);
	const capability = Object.freeze(Object.create(null)) as WorkspaceMarkerCapability;
	issuedWorkspaceMarkerCapabilities.set(capability as object, Object.freeze({
		root: canonicalRoot,
		authority,
		pinnedRoot: opened.value,
	}));
	return capability;
}

