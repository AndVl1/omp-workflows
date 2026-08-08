/**
 * /do-work — OMP custom-TS command (formerly /team).
 *
 * Part of the omp-workflows bundle. Loaded by OMP from
 * `.omp/commands/do-work/index.ts` (copied at install time by the
 * fullstack package's `postinstall` hook).
 *
 * Contract:
 * - Receives `HookCommandContext` (ui, cwd, sessionManager, modelRegistry).
 * - Returns a string that is fed to the main agent as the next prompt.
 *   The main agent owns the `task` tool and runs the workflow through it.
 * - Does NOT call `task` directly (custom-TS commands lack that surface).
 *
 * Supported prefixes (mechanical HINTS only — the model decides autonomy):
 * - `[AUTONOMOUS] <task> [issue=#N]` — sets the autonomy hint ON.
 * - `<task> [issue=#N]`              — hint OFF.
 *
 * Returns a classification-first prompt that:
 *  1. Makes the main LLM semantically understand the task before routing.
 *     PHASE-0 classifies type/complexity/confidence/autonomous together; the
 *     parser hint is non-authoritative and never drives state.
 *  2. Resolves the profile only after the classification gate.
 *  3. Walks the selected profile through the main agent's `task` tool.
 *  4. Resolves role mapping from `.omp/team.config.json`.
 *
 * Backwards compatibility: a sibling command `/team` (`commands/team/index.ts`)
 * is shipped as a thin alias that delegates to the same `parseEnvelope` /
 * `buildPrompt` so old keybinds and muscle memory still work. Both commands
 * resolve to the same workflow.
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import { buildDoWorkPrompt, parseWorkEnvelope } from "@andvl1/omp-workflows-core";

export const parseEnvelope = parseWorkEnvelope;
export const buildPrompt = buildDoWorkPrompt;


export type { ParsedWorkEnvelope as ParsedEnvelope } from "@andvl1/omp-workflows-core";


// The generic envelope and prompt contract are canonical in core.


const factory = (api: CustomCommandAPI): CustomCommand => ({
	name: "do-work",
	description: "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)",
	async execute(args: string[], ctx: HookCommandContext): Promise<string> {
		const raw = args.join(" ").trim();
		if (!raw) {
			return [
				"Usage: /do-work <task description>",
				"",
				"Examples:",
				"  /do-work Add OAuth authentication with Google and GitHub",
				"  /do-work [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
				"",
				"Alias: `/team` works too.",
			].join("\n");
		}
		const cwd = ctx.cwd ?? api.cwd;
		if (!cwd) return "ERROR: no cwd available.";
		const envelope = parseEnvelope(raw, cwd);
		if (!envelope.task) return "ERROR: empty task after stripping prefix.";
		ctx.ui?.notify?.(`do-work: ${envelope.task.slice(0, 60)} (workflow pending)`, "info");
		return buildPrompt(envelope, cwd);
	},
});

export default factory;
