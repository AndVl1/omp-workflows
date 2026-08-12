import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	buildAmendPrompt,
	buildCtoPrompt,
	buildStandbyCtoPrompt,
	findActiveCtoRun,
	parseEnvelope as parseCtoEnvelope,
} from "./cto.js";
import { buildDoWorkPrompt, parseWorkEnvelope, type ParsedWorkEnvelope } from "./do-work.js";

const DO_WORK_DESCRIPTION = "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)";
const TEAM_DESCRIPTION = "Alias for /do-work. Prefer /do-work in new code.";
const CTO_DESCRIPTION =
	"CTO sub-orchestration (main-session role): the resident CTO decomposes a task into parallel development teams. /cto <task>; /cto alone starts STANDBY (tasks arrive via messenger inbox). Runs in-session — never task(agent=cto)";

export interface WorkflowCommandOptions {
	buildDoWorkPrompt?: (envelope: ParsedWorkEnvelope, cwd: string) => string;
	doWorkDescription?: string;
	teamDescription?: string;
	ctoDescription?: string;
}

function registerPromptCommand(
	pi: ExtensionAPI,
	name: string,
	description: string,
	buildPrompt: (args: string, ctx: ExtensionCommandContext) => string,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			pi.sendUserMessage(buildPrompt(args.trim(), ctx));
		},
	});
}

function buildDoWorkCommandPrompt(
	args: string,
	ctx: ExtensionCommandContext,
	commandName: "do-work" | "team",
	promptBuilder: (envelope: ParsedWorkEnvelope, cwd: string) => string,
): string {
	if (!args) {
		return commandName === "do-work"
			? [
					"Usage: /do-work <task description>",
					"",
					"Examples:",
					"  /do-work Add OAuth authentication with Google and GitHub",
					"  /do-work [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
					"",
					"Alias: `/team` works too.",
				].join("\n")
			: [
					"Usage: /team <task description>  (alias for /do-work)",
					"",
					"Examples:",
					"  /team Add OAuth authentication with Google and GitHub",
					"  /team [AUTONOMOUS] Fix the 500 error on /api/users issue=#42",
				].join("\n");
	}

	const envelope = parseWorkEnvelope(args, ctx.cwd);
	if (!envelope.task) return "ERROR: empty task after stripping prefix.";
	ctx.ui.notify(`${commandName}: ${envelope.task.slice(0, 60)} (workflow pending)`, "info");
	return promptBuilder(envelope, ctx.cwd);
}

function buildCtoCommandPrompt(args: string, ctx: ExtensionCommandContext): string {
	if (!args) {
		ctx.ui.notify("cto: standby mode — awaiting tasks via messenger inbox", "info");
		return buildStandbyCtoPrompt(ctx.cwd);
	}

	const sessionId = ctx.sessionManager.getSessionId();
	const envelope = parseCtoEnvelope(args, ctx.cwd);
	if (!envelope.task) return "ERROR: empty task after stripping prefix.";
	const active = findActiveCtoRun(ctx.cwd, { sessionId });
	if (active) {
		ctx.ui.notify(`cto: amending run ${active.runId} with: ${envelope.task.slice(0, 50)}`, "info");
		return buildAmendPrompt(envelope, ctx.cwd, active, { sessionId });
	}
	ctx.ui.notify(`cto: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
	return buildCtoPrompt(envelope, ctx.cwd, { sessionId });
}

/** Register workflow entry points during extension load, before OMP snapshots slash suggestions. */
export function registerWorkflowCommands(pi: ExtensionAPI, options: WorkflowCommandOptions = {}): void {
	const promptBuilder = options.buildDoWorkPrompt ?? buildDoWorkPrompt;
	registerPromptCommand(pi, "do-work", options.doWorkDescription ?? DO_WORK_DESCRIPTION, (args, ctx) =>
		buildDoWorkCommandPrompt(args, ctx, "do-work", promptBuilder),
	);
	registerPromptCommand(pi, "team", options.teamDescription ?? TEAM_DESCRIPTION, (args, ctx) =>
		buildDoWorkCommandPrompt(args, ctx, "team", promptBuilder),
	);
	registerPromptCommand(pi, "cto", options.ctoDescription ?? CTO_DESCRIPTION, buildCtoCommandPrompt);
}
