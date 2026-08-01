/**
 * /interview — OMP custom-TS command.
 *
 * Hands off to the `analyst` agent for structured clarifying questions.
 * The command itself just emits a prompt that names the topic and the
 * agent; the main agent forwards to `task` with `agent: "analyst"`.
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

const factory = (_api: CustomCommandAPI): CustomCommand => ({
	name: "interview",
	description: "Deep interview to clarify ideas before implementation. /interview <topic>.",
	async execute(args: string[], ctx: HookCommandContext): Promise<string> {
		const topic = args.join(" ").trim();
		if (!topic) return "Usage: /interview <topic>";
		ctx.ui?.notify?.(`interview: starting on '${topic.slice(0, 60)}'`, "info");
		return [
			"Interview — start a structured clarifying conversation.",
			"",
			"### Topic",
			topic,
			"",
			"### How to drive",
			[
				"1. Use the `task` tool with `agent: 'analyst'` to dispatch a structured interview.",
				"2. Cover:",
				"   - Surface goals and non-goals.",
				"   - Constraints (deadline, stack, infra).",
				"   - Risk surface (security, scale, compliance).",
				"   - Acceptance criteria in concrete terms.",
				"   - Definition-of-done items the team should commit to.",
				"3. Synthesize the answers into an expanded task description that the next /team call can act on.",
			].join("\n"),
		].join("\n");
	},
});

export default factory;
