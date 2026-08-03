/**
 * Workflow profile resolver for the custom-TS commands.
 *
 * The prompt built by `buildPrompt` used to tell the main agent to *read*
 * `packages/core/workflows/<name>.json` — a RELATIVE path that only resolves
 * from the monorepo root. From a git worktree, a subdirectory, or a consumer
 * project the file is not there, so the agent went on a filesystem-wide hunt
 * (globbing `workflows`/`profiles` trees, reading command sources, scanning
 * `~/.omp/plugins` caches, `find /` …).
 *
 * Instead we resolve the profile at prompt-build time and hand the agent the
 * ABSOLUTE, existence-checked path, plus a compact stage skeleton so it knows
 * the shape before opening the file. The agent reads exactly that one file —
 * no guessing, no searching.
 *
 * Resolution order (first hit wins):
 *   1. `<cwd>/packages/core/workflows/<name>.json`            — dev monorepo
 *   2. walking up from `cwd` (≤4 levels) for the same path     — worktree/subdir of the monorepo
 *   3. `<cwd>/node_modules/@andvl1/omp-workflows-core/workflows/…` — npm consumer
 *   4. `~/.omp/plugins/node_modules/@andvl1/omp-workflows-core/workflows/…` — `omp plugin install`
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface WorkflowStage {
	id: string;
	title: string;
	type: "orchestrator" | "single" | "consilium" | "bash" | "none";
	roles?: string[];
	role?: string;
	parallel?: boolean;
	consumes?: string[];
	produces?: string | string[];
	checkpoint?: string;
	autonomous?: string;
	gate?: string;
	skip_if?: string;
	conditional?: Array<{ if: string; add?: string | string[]; remove?: string | string[] }>;
	loop?: { back_to: string; until?: string; max_iterations?: number; on_exhausted?: string };
}

export interface WorkflowProfile {
	name: string;
	title: string;
	description?: string;
	match: { type: string[]; complexity?: string[] };
	stages: WorkflowStage[];
}

const MAX_WALK_UP = 4;

function candidatePaths(name: string, cwd: string): string[] {
	const rel = ["packages", "core", "workflows", `${name}.json`];
	const fromCwd: string[] = [];
	let dir = cwd;
	for (let i = 0; i <= MAX_WALK_UP; i++) {
		fromCwd.push(resolve(dir, ...rel));
		dir = dirname(dir);
	}
	return [
		...fromCwd,
		resolve(cwd, "node_modules", "@andvl1", "omp-workflows-core", "workflows", `${name}.json`),
		resolve(
			homedir(),
			".omp",
			"plugins",
			"node_modules",
			"@andvl1",
			"omp-workflows-core",
			"workflows",
			`${name}.json`,
		),
	];
}

export function resolveWorkflowProfilePath(name: string, cwd: string): string | null {
	for (const p of candidatePaths(name, cwd)) {
		try {
			if (!existsSync(p)) continue;
			const raw = JSON.parse(readFileSync(p, "utf8")) as WorkflowProfile;
			if (raw.name === name && Array.isArray(raw.stages) && raw.stages.length > 0) {
				return p;
			}
		} catch {
			// Corrupt or partial file — keep looking.
		}
	}
	return null;
}

export function loadWorkflowProfile(name: string, cwd: string): WorkflowProfile | null {
	const path = resolveWorkflowProfilePath(name, cwd);
	if (!path) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as WorkflowProfile;
	} catch {
		return null;
	}
}

/**
 * Compact one-stage-per-line overview: id, title, type, plus the behavioural
 * stop-signs the orchestrator MUST honour before it can proceed — gate,
 * checkpoint (with its auto-decision), skip_if. These are inlined because
 * skipping them is the failure mode we guard against: an agent that flies
 * past a checkpoint or gate without reading the profile. Artifact wiring
 * (produces/consumes) stays in the profile file itself.
 */
export function renderStagesSkeleton(profile: WorkflowProfile): string {
	return profile.stages.map((s, i) => {
		const bits: string[] = [`${i + 1}. \`${s.id}\` — ${s.title} [${s.type}]`];
		if (s.gate) bits.push(`gate=${s.gate}`);
		if (s.checkpoint) {
			bits.push(`checkpoint=${s.checkpoint}${s.autonomous ? ` (auto: ${s.autonomous})` : ""}`);
		}
		if (s.skip_if) bits.push(`skip_if=${s.skip_if}`);
		return bits.join(" ");
	}).join("\n");
}
