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

import { join } from "node:path";
import { PinnedProjectRoot } from "@andvl1/omp-workflows-core";
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

const DEFAULT_CONFIG = {
	roles: {
		analyst: "analyst",
		"tech-researcher": "tech-researcher",
		diagnostics: "diagnostics",
		architect: "architect",
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

const CONFIG_RELATIVE_PATH = ".omp/team.config.json";
const MAX_CONFIG_BYTES = 1024 * 1024;

function assertSafeConfigTarget(root: PinnedProjectRoot): ReturnType<PinnedProjectRoot["pathEntryInfo"]> {
	if (!root.isStable()) throw new Error("init-team: project root changed before configuration access");
	const omp = root.pathEntryInfo(".omp");
	if (omp !== null && omp.kind !== "directory") throw new Error("init-team: .omp must be a real directory");
	const config = root.pathEntryInfo(CONFIG_RELATIVE_PATH);
	if (config !== null && config.kind !== "file") throw new Error("init-team: team.config.json must be a regular file");
	return config;
}

function writeConfig(root: PinnedProjectRoot, force: boolean): string {
	const config = assertSafeConfigTarget(root);
	const configPath = join(root.canonical_root, CONFIG_RELATIVE_PATH);
	if (config !== null && !force) return `init-team: ${configPath} already exists. Skipping. Edit by hand, or run with --force to regenerate (deleting the file alone is not enough: omp re-seeds it on the next session start).`;
	const serialized = JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
	if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) throw new Error("init-team: generated configuration exceeds the bounded write size");
	root.writeAtomic(CONFIG_RELATIVE_PATH, serialized);
	const after = assertSafeConfigTarget(root);
	if (after === null) throw new Error("init-team: configuration disappeared after atomic write");
	const observed = root.readFile(CONFIG_RELATIVE_PATH, { maxBytes: MAX_CONFIG_BYTES }).bytes;
	if (!Buffer.from(observed).equals(Buffer.from(serialized, "utf8"))) throw new Error("init-team: configuration changed after atomic write");
	if (!root.isStable()) throw new Error("init-team: project root changed after configuration write");
	return `init-team: wrote ${configPath}`;
}

const factory = (_api: CustomCommandAPI): CustomCommand => ({
	name: "init-team",
	description: "Detect stacks and emit .omp/team.config.json (idempotent).",
	async execute(args: string[], ctx: HookCommandContext): Promise<string> {
		const cwd = ctx.cwd ?? _api.cwd;
		if (typeof cwd !== "string" || cwd.length === 0) return "ERROR: no cwd available.";
		const root = PinnedProjectRoot.open(cwd);
		if (!root) return "ERROR: project root cannot be pinned safely.";
		try {
			const result = writeConfig(root, args.includes("--force"));
			if (result.startsWith("init-team: wrote ")) ctx.ui?.notify?.(result, "info");
			return result;
		} finally {
			root.close();
		}
	},
});

export default factory;
