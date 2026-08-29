/**
 * Immutable catalog inputs shipped by the private provider.
 *
 * These files are provider data, not project policy or runtime authority.
 * The provider module reads them once and pins their exact identities with
 * core's canonical catalog builder before publication.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Profile } from "@andvl1/omp-workflows-core";

const INTERNAL_PROFILE_ASSETS = ["omp-feature.json", "omp-validate.json"] as const;

/**
 * Read the two immutable profile assets from this package.
 *
 * The package root is derived from this module URL, never from process cwd or
 * a project-local configuration path.
 */
export function readInternalWorkflowProfiles(): readonly Profile[] {
	const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	return Object.freeze(
		INTERNAL_PROFILE_ASSETS.map((asset) => {
			const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "workflows", asset), "utf8"));
			assertValidProfileAsset(asset, parsed);
			return parsed;
		}),
	);
}

function assertValidProfileAsset(asset: string, parsed: unknown): asserts parsed is Profile {
	const issues: string[] = [];
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`invalid provider profile asset '${asset}': not an object`);
	}
	const profile = parsed as Partial<Profile>;
	if (typeof profile.name !== "string" || profile.name.length === 0) {
		issues.push("$.name must be a non-empty string");
	}
	if (!Array.isArray(profile.stages) || profile.stages.length === 0) {
		issues.push("$.stages must be a non-empty array");
	}
	if (!profile.match || typeof profile.match !== "object" || Array.isArray(profile.match)) {
		issues.push("$.match must be an object");
	}
	if (issues.length > 0) throw new Error(`invalid provider profile asset '${asset}': ${issues.join("; ")}`);

	const stages = profile.stages;
	if (!Array.isArray(stages) || stages.length === 0) {
		throw new Error(`invalid provider profile asset '${asset}': $.stages must be a non-empty array`);
	}

	const stageIds = new Set<string>();
	for (const [index, stage] of stages.entries()) {
		if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
			issues.push(`$.stages[${index}] must be an object`);
			continue;
		}
		const candidate = stage as { id?: unknown; checkpoint?: unknown };
		if (typeof candidate.id !== "string" || candidate.id.length === 0) {
			issues.push(`$.stages[${index}].id must be a non-empty string`);
			continue;
		}
		if (stageIds.has(candidate.id)) issues.push(`$.stages[${index}].id duplicates '${candidate.id}'`);
		stageIds.add(candidate.id);
		if (typeof candidate.checkpoint === "string") {
			const rules = profile.checkpoint_policy?.rules;
			if (profile.checkpoint_policy && (!rules || !(candidate.checkpoint in rules))) {
				issues.push(`$.checkpoint_policy.rules.${candidate.checkpoint} missing for declared checkpoint`);
			}
		}
	}
	if (issues.length > 0) throw new Error(`invalid provider profile asset '${asset}': ${issues.join("; ")}`);
}
