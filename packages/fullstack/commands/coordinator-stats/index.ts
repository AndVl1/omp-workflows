/**
 * /coordinator-stats — OMP custom-TS command.
 *
 * Roll up profile-usage and propose new workflow profiles. Reads
 * `.work-state/coordinator/profile-stats.md` (produced by the
 * `coordinator` agent over time) and returns it as a digest.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

const WORK_STATE_DIR = ".work-state";

const factory = (_api: CustomCommandAPI): CustomCommand => ({
	name: "coordinator-stats",
	description: "Rollup profile-usage and propose new profiles.",
	async execute(_args: string[], ctx: HookCommandContext): Promise<string> {
		const cwd = ctx.cwd ?? _api.cwd;
		if (!cwd) return "ERROR: no cwd available.";
		const statsPath = resolve(cwd, WORK_STATE_DIR, "coordinator", "profile-stats.md");
		if (!existsSync(statsPath)) {
			return [
				"coordinator-stats: no profile-stats.md yet.",
				"Run several /team invocations so the coordinator agent can record profile usage.",
				"Then this command will return the rolled-up digest.",
			].join("\n");
		}
		const age = statSync(statsPath).mtime.toISOString();
		const body = readFileSync(statsPath, "utf8");
		ctx.ui?.notify?.(`coordinator-stats: showing ${statsPath} (mtime=${age})`, "info");
		return body;
	},
});

export default factory;
