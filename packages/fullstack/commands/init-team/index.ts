/**
 * /init-team — OMP custom-TS command.
 *
 * Detect stacks and emit `.omp/team.config.json`. The shipped config is a
 * fixed fullstack defaults bootstrap; the heavy stack detection happens
 * either at the main agent's request via the `discovery` agent or by the
 * user pasting in their own config.
 *
 * Idempotent, but deletion alone does not reset state: opening omp re-seeds
 * a missing config from the bundle preset on session_start. Use `--force`
 * to regenerate over any existing file.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

const DEFAULT_CONFIG = {
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
	roster_overrides: {},
	scope_map: [
		{
			glob: ["**/iosApp/**", "**/composeApp/**", "**/commonMain/**", "**/androidMain/**"],
			scope: "mobile",
			dev_agent: "developer-mobile",
		},
		{
			glob: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.ts", "**/src/jsMain/**", "**/miniapp/**", "**/frontend/**"],
			scope: "frontend",
			dev_agent: "frontend-developer",
		},
		{
			glob: ["**/*.go", "**/go.mod", "**/go.sum"],
			scope: "go",
			dev_agent: "developer-go",
		},
		{
			glob: ["**/Dockerfile", "**/*.yaml", "**/*.yml", "**/helm/**", "**/.github/**", "**/k8s/**"],
			scope: "devops",
			dev_agent: "devops",
		},
		{ glob: ["**/*.kt", "**/*.java", "**/src/main/**"], scope: "backend-kotlin", dev_agent: "developer-kotlin" },
	],
	flags: {
		has_security: ["**/auth/**", "**/security/**", "**/*crypto*", "**/*Secret*", "**/*Token*"],
		has_infra: ["**/Dockerfile", "**/helm/**", "**/k8s/**", "**/.github/workflows/**"],
	},
	design_system: null,
};

const factory = (_api: CustomCommandAPI): CustomCommand => ({
	name: "init-team",
	description: "Detect stacks and emit .omp/team.config.json (idempotent).",
	async execute(args: string[], ctx: HookCommandContext): Promise<string> {
		const cwd = ctx.cwd ?? _api.cwd;
		if (!cwd) return "ERROR: no cwd available.";
		const dir = resolve(cwd, ".omp");
		const path = join(dir, "team.config.json");
		if (existsSync(path) && !args.includes("--force")) {
			return `init-team: ${path} already exists. Skipping. Edit by hand, or run with --force to regenerate (deleting the file alone is not enough: omp re-seeds it on the next session start).`;
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
		ctx.ui?.notify?.(`init-team: wrote ${path}`, "info");
		return `init-team: wrote ${path}`;
	},
});

export default factory;
