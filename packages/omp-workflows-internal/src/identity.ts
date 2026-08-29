/**
 * Stable identity for the private workflow provider.
 *
 * This package is a separate provider from the public fullstack bundle. The
 * marker is an explicit launcher/admission precondition only; it is never
 * converted into a cwd-derived owner claim or a runtime configuration source.
 */

/** Provider identity — also the npm package name. */
export const OMP_INTERNAL_BUNDLE_ID = "@andvl1/omp-workflows-internal";

/**
 * Launcher marker required before this provider may be published for a
 * project. Detection lives in `activation.ts`; this value is descriptive.
 */
export const OMP_INTERNAL_ACTIVATION_MARKER =
	"workspace:package.json+packages/core+packages/fullstack";

