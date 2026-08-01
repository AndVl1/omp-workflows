/**
 * /team — OMP custom-TS command (legacy alias for /do-work).
 *
 * Kept as a thin wrapper so users who trained their muscle memory on the
 * old name can keep using it. The command body delegates to the same
 * `parseEnvelope` / `buildPrompt` exported by `../do-work/index.ts`, so
 * both commands resolve to a single workflow definition. New code should
 * use `/do-work` directly.
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import { buildPrompt, parseEnvelope } from "../do-work/index.js";

const factory = (api: CustomCommandAPI): CustomCommand => ({
	name: "team",
	description: "Alias for /do-work. Prefer /do-work in new code.",
	async execute(args: string[], ctx: HookCommandContext): Promise<string> {
		const raw = args.join(" ").trim();
		if (!raw) {
			return [
				"Usage: /team <task description>  (alias for /do-work)",
				"",
				"Examples:",
				"  /team Add OAuth authentication with Google and GitHub",
				"  /team [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
			].join("\n");
		}
		const cwd = ctx.cwd ?? api.cwd;
		if (!cwd) return "ERROR: no cwd available.";
		const envelope = parseEnvelope(raw, cwd);
		if (!envelope.task) return "ERROR: empty task after stripping prefix.";
		ctx.ui?.notify?.(`team: ${envelope.task.slice(0, 60)} (workflow pending)`, "info");
		return buildPrompt(envelope, cwd);
	},
});

export default factory;
