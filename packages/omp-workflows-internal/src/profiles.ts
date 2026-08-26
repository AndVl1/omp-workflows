/**
 * Bundle-owned workflow profile assets.
 *
 * Profiles live in workflows/*.json and are registered into the core
 * interpreter via `registerTeamWorkflow({ workflowProfiles })`. Loaded from
 * disk relative to this module (one directory below the package root in both
 * src/ and dist/ layouts) so no static JSON import is needed. Structural
 * validation is local because the core control-plane validator is not part of
 * the public core surface; registration remains fail-closed either way.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Profile } from "@andvl1/omp-workflows-core";

const PROFILE_ASSETS = ["omp-feature.json", "omp-validate.json"] as const;

/**
 * Load and structurally validate the bundle profiles. Throws on any defect so
 * callers can fail closed BEFORE claiming owners or registering tools.
 */
export function loadOmpWorkflowProfiles(): Profile[] {
	// One directory below the package root in both src/ and dist/ layouts.
	const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	return PROFILE_ASSETS.map((asset) => {
		const path = join(packageRoot, "workflows", asset);
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		assertValidProfileAsset(asset, parsed);
		return parsed as Profile;
	});
}

function assertValidProfileAsset(asset: string, parsed: unknown): void {
	const issues: string[] = [];
	const profile = parsed as Profile | null;
	if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
		throw new Error(`invalid workflow profile asset '${asset}': not an object`);
	}
	if (typeof profile?.name !== "string" || profile.name.length === 0) {
		issues.push("$.name must be a non-empty string");
	}
	if (!Array.isArray(profile?.stages)) {
		issues.push("$.stages must be an array");
	}
	if (!profile?.match || typeof profile.match !== "object") {
		issues.push("$.match must be an object");
	}
	if (issues.length > 0) throw new Error(`invalid workflow profile asset '${asset}': ${issues.join("; ")}`);

	const stageIds = new Set<string>();
	for (const [index, stage] of profile.stages.entries()) {
		if (!stage || typeof stage !== "object") {
			issues.push(`$.stages[${index}] must be an object`);
			continue;
		}
		if (typeof stage.id !== "string" || stage.id.length === 0) {
			issues.push(`$.stages[${index}].id must be a non-empty string`);
			continue;
		}
		if (stageIds.has(stage.id)) issues.push(`$.stages[${index}].id duplicates '${stage.id}'`);
		stageIds.add(stage.id);
		if (stage.checkpoint && typeof stage.checkpoint === "string") {
			const rules = profile.checkpoint_policy?.rules;
			if (profile.checkpoint_policy && (!rules || !(stage.checkpoint in rules))) {
				issues.push(`$.checkpoint_policy.rules.${stage.checkpoint} missing for declared checkpoint`);
			}
		}
	}
	if (issues.length > 0) {
		throw new Error(`invalid workflow profile asset '${asset}': ${issues.join("; ")}`);
	}
}
