/**
 * Public API for the `model-overrides` package module.
 *
 * Consumers (the `.omp/commands/omp-model-overrides/index.ts` entry
 * point and external tests) import from here rather than the inner
 * files so the surface stays stable.
 */

export {
	CORE_OVERRIDABLE_ROLES,
	ModelsJsonError,
	validateModelsJson,
	type CoreOverridableRole,
	type ModelEntry,
	type ModelsJson,
	type OverrideEntry,
} from "./schema.js";

export {
	defaultBundledAgentsDir,
	defaultModelEntries,
	nodeFsAdapter,
	noopUi,
	patchAgentFrontmatter,
	runModelOverrides,
	type FsAdapter,
	type RunModelOverridesInput,
	type RunModelOverridesResult,
	type UiAdapter,
} from "./command.js";
