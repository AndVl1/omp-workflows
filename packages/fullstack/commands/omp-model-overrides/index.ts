/**
 * /omp-model-overrides — OMP custom-TS command.
 *
 * Thin entry point that delegates the real work to
 * `@andvl1/omp-workflows-core`'s `runModelOverrides`. This file lives
 * under `.omp/commands/` so OMP auto-discovers it and registers it as
 * a slash command.
 *
 * Usage:
 *   /omp-model-overrides          # initialise or refresh .omp/models.json + .omp/agents/
 *   /omp-model-overrides --force  # force regeneration even when .omp/models.json absent
 *
 * The command is interactive: when run without `--preset`, the user is
 * asked per role which model to use. (For headless use, callers should
 * pass a preset programmatically via the core API.)
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

import { runModelOverrides } from "@andvl1/omp-workflows-core/model-overrides";

const factory = (_api: CustomCommandAPI): CustomCommand => ({
	name: "omp-model-overrides",
	description: "Configure per-role model overrides for this project (writes .omp/models.json + .omp/agents/<role>-<model>/).",
	async execute(args: string[], ctx: HookCommandContext): Promise<string> {
		const cwd = ctx.cwd ?? _api.cwd;
		if (!cwd) return "ERROR: no cwd available.";

		const force = args.includes("--force");

		// Notify-only UI adapter: the interactive prompt happens at a higher
		// layer (model_selection stage in /team, or a future TUI). The
		// command itself writes deterministic files from the current
		// .omp/models.json + presets, leaving the human-in-the-loop choice
		// to a separate interactive flow that calls runModelOverrides with
		// `presetOverrides`.
		const result = runModelOverrides({
			cwd,
			force,
		});

		ctx.ui?.notify?.(`omp-model-overrides: ${result.status}`, result.status === "failed" ? "error" : "info");
		return result.message;
	},
});

export default factory;
