/**
 * Frozen bundle identity for the private OMP package.
 *
 * These constants are a contract: the owner registry fingerprints them, and
 * dual-owner conflicts between this bundle and any other (e.g. fullstack as a
 * user plugin) are decided by exact string equality. Do not reword them.
 */

import { join, resolve } from "node:path";

import type { WorkflowOwnerIdentity } from "@andvl1/omp-workflows-core";

import { detectWorkspaceMarkers } from "./activation.js";

/** Bundle identity — also the npm package name. */
export const OMP_INTERNAL_BUNDLE_ID = "@andvl1/omp-workflows-internal";

/**
 * Activation marker carried in the owner identity. The gate itself lives in
 * `activation.ts`; this string describes the marker set, it does not detect it.
 */
export const OMP_INTERNAL_ACTIVATION_MARKER =
	"workspace:package.json+packages/core+packages/fullstack";

/** Owner kind for private, workspace-scoped bundles. */
export const OMP_INTERNAL_OWNER_KIND = "private_omp" as const;

/** Supported host range, mirroring the core/fullstack contract. */
export const OMP_INTERNAL_HOST_RANGE = ">=17.3 <19";

/**
 * Build the workflow owner identity for a session project root.
 *
 * Mirrors `fullstackOwnerForCwd` (packages/fullstack/src/index.ts): provenance
 * cwd is the resolved root and config ownership is scoped to
 * `<root>/.omp/team.config.json`, which the core claim API validates.
 */
export function privateOmpOwnerForCwd(cwd: string): WorkflowOwnerIdentity {
	const root = resolve(cwd);
	return {
		owner_id: OMP_INTERNAL_BUNDLE_ID,
		bundle_id: OMP_INTERNAL_BUNDLE_ID,
		owner_kind: OMP_INTERNAL_OWNER_KIND,
		activation_marker: OMP_INTERNAL_ACTIVATION_MARKER,
		host_range: OMP_INTERNAL_HOST_RANGE,
		provenance: {
			package: OMP_INTERNAL_BUNDLE_ID,
			entrypoint: "dist/index.js",
			cwd: root,
			config_path: join(root, ".omp", "team.config.json"),
		},
	};
}

/**
 * Owner source for the namespaced command surface.
 *
 * Core's command seam resolves an effective cwd and then claims
 * `workflow_registration` for it before executing a handler. When the session
 * cwd is NOT a marked internal workspace, that claim must never happen with
 * the private identity — otherwise the bundle would register itself as the
 * workflow-registration owner of an arbitrary unmarked project (and a later
 * fullstack activation there would hit a bogus owner conflict). Throwing
 * from the owner source aborts core's claim path before the registry is
 * touched, which keeps fail-closed semantics: zero owners outside the
 * marked workspace, and the typed marker code as the diagnostic.
 */
export function privateOmpOwnerForMarkedWorkspace(cwd: string): WorkflowOwnerIdentity {
	if (!detectWorkspaceMarkers(cwd).ok) {
		throw new Error(`activation_markers_missing: ${OMP_INTERNAL_ACTIVATION_MARKER}`);
	}
	return privateOmpOwnerForCwd(cwd);
}
