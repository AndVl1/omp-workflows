/**
 * /pulse — OMP custom-TS command.
 *
 * Read-only project steward: digest + next-action menu. Reads:
 *   - `.work-state/team-state.json`   (current workflow state)
 *   - `.work-state/coordinator/`      (coordinator memory)
 *   - git status / log                (commit activity)
 *   - beads ready list                (next task)
 *
 * Returns a Markdown digest the LLM (or the user) can act on.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

const WORK_STATE_DIR = ".work-state";

interface TeamState {
	branch?: string;
	classification?: { type: string; complexity: string; workflow: string };
	stage_cursor?: string;
	stages?: Array<{ id: string; status: string }>;
	pause?: { kind: string; reason?: string };
	issue?: { number: number; url?: string } | null;
	updated_at?: string;
}

function safeExec(cmd: string, cwd: string): string | null {
	try {
		return execSync(cmd, { cwd, encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

function readTeamState(cwd: string): TeamState | null {
	const path = resolve(cwd, WORK_STATE_DIR, "team-state.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as TeamState;
	} catch {
		return null;
	}
}

function readBeadsReady(cwd: string): string {
	try {
		const out = execSync("br ready --json", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out;
	} catch {
		return "";
	}
}

function buildDigest(cwd: string): string {
	const lines: string[] = ["## Pulse", ""];
	const state = readTeamState(cwd);
	if (!state) {
		lines.push("No .work-state/team-state.json — run /team first to bootstrap.");
		lines.push("");
	}
	const branch = safeExec("git branch --show-current", cwd);
	lines.push(`Branch: ${branch ?? "(none)"}`);
	lines.push("");

	if (state) {
		lines.push("### Workflow");
		lines.push(
			`- Classification: ${state.classification?.type ?? "?"}/${state.classification?.complexity ?? "?"} (workflow=${state.classification?.workflow ?? "?"})`,
		);
		lines.push(`- Cursor: ${state.stage_cursor ?? "(none)"}`);
		lines.push(`- Pause: ${state.pause?.kind ?? "none"}${state.pause?.reason ? ` (${state.pause.reason})` : ""}`);
		if (Array.isArray(state.stages) && state.stages.length > 0) {
			lines.push("- Stages:");
			for (const s of state.stages) {
				lines.push(`  - ${s.id}: ${s.status}`);
			}
		}
		lines.push("");
	}

	const status = safeExec("git status --short", cwd);
	lines.push("### git status");
	lines.push(status || "(clean)");
	lines.push("");

	const last = safeExec("git log --oneline -10", cwd);
	lines.push("### last 10 commits");
	lines.push(last || "(none)");
	lines.push("");

	const ready = readBeadsReady(cwd);
	if (ready) {
		lines.push("### beads ready");
		lines.push("```");
		lines.push(ready);
		lines.push("```");
		lines.push("");
	}

	lines.push("### next actions");
	lines.push("- /team <feature>");
	lines.push("- /team-next (run next queued task)");
	lines.push("- /init-team (if .omp/team.config.json missing)");
	lines.push("- /coordinator-stats");
	lines.push("");

	return lines.join("\n");
}

const factory = (_api: CustomCommandAPI): CustomCommand => ({
	name: "pulse",
	description: "Read-only project steward: digest + next-action menu.",
	async execute(_args: string[], ctx: HookCommandContext): Promise<string> {
		const cwd = ctx.cwd ?? _api.cwd;
		if (!cwd) return "ERROR: no cwd available.";
		ctx.ui?.notify?.("pulse: scanning project state", "info");
		return buildDigest(cwd);
	},
});

export default factory;
