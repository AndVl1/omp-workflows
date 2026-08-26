/**
 * Frozen bundle identity for the private OMP package.
 *
 * These constants are a contract: the owner registry fingerprints them, and
 * dual-owner conflicts between this bundle and any other (e.g. fullstack as a
 * user plugin) are decided by exact string equality. Do not reword them.
 */

import { join, resolve } from "node:path";

import type { WorkflowOwnerIdentity } from "@andvl1/omp-workflows-core";

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
