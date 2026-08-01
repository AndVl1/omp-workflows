/**
 * Read `.omp/team.config.json` from the project root. This is the same
 * config the extension writes at `registerTeamWorkflow` time. The custom-TS
 * command reads it so it can show the role mapping in the prompt and the
 * main agent knows which agent to dispatch for each role.
 *
 * If the config is missing, fall back to the fullstack defaults so the
 * command still returns a usable prompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TeamConfig {
	roles?: Record<string, string>;
	scope_map?: Array<{ glob: string[]; scope: string; dev_agent: string }>;
	flags?: Record<string, string[]>;
	design_system?: string | null;
}

export const DEFAULT_TEAM_CONFIG: TeamConfig = {
	roles: {
		analyst: "analyst",
		"tech-researcher": "tech-researcher",
		diagnostics: "diagnostics",
		architect: "architect",
		architect_minimal: "architect",
		architect_clean: "architect",
		architect_pragmatic: "architect",
		"backend-kotlin": "developer-kotlin",
		go: "developer-go",
		frontend: "frontend-developer",
		mobile: "developer-mobile",
		qa: "qa",
		"manual-qa": "manual-qa",
		"code-reviewer": "code-reviewer",
		"security-tester": "security-tester",
		devops: "devops",
	},
	scope_map: [],
	flags: {},
};

export function loadTeamConfig(cwd: string): TeamConfig {
	const configPath = resolve(cwd, ".omp", "team.config.json");
	if (!existsSync(configPath)) {
		return DEFAULT_TEAM_CONFIG;
	}
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as TeamConfig;
		return {
			roles: { ...DEFAULT_TEAM_CONFIG.roles, ...(raw.roles ?? {}) },
			scope_map: raw.scope_map ?? [],
			flags: raw.flags ?? {},
			design_system: raw.design_system ?? null,
		};
	} catch {
		return DEFAULT_TEAM_CONFIG;
	}
}
