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
/**
 * Resolve the project root from the session manager first.
 *
 * OMP has shipped runtimes where the command context's `cwd` is absent or
 * lags the session after a resume/switch. The session manager owns the
 * session's canonical project root; the context and process cwd are
 * compatibility fallbacks for older test/runtime hosts.
 */
function resolveCommandCwd(ctx: ExtensionCommandContext): string {
	const sessionManager = ctx.sessionManager as unknown as { getCwd?: () => unknown } | undefined;
	try {
		const sessionCwd = sessionManager?.getCwd?.();
		if (typeof sessionCwd === "string" && sessionCwd.length > 0) return sessionCwd;
	} catch {
		// Fall through to the context/process fallback.
	}
	if (typeof ctx.cwd === "string" && ctx.cwd.length > 0) return ctx.cwd;
	return process.cwd();
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

	const cwd = resolveCommandCwd(ctx);
	const envelope = parseWorkEnvelope(args, cwd);
	if (!envelope.task) return "ERROR: empty task after stripping prefix.";
	ctx.ui.notify(`${commandName}: ${envelope.task.slice(0, 60)} (workflow pending)`, "info");
	return promptBuilder(envelope, cwd);
}

function buildCtoCommandPrompt(args: string, ctx: ExtensionCommandContext): string {
	const cwd = resolveCommandCwd(ctx);
	if (!args) {
		ctx.ui.notify("cto: standby mode — awaiting tasks via messenger inbox", "info");
		return buildStandbyCtoPrompt(cwd);
	}

	const sessionId = ctx.sessionManager.getSessionId();
	const envelope = parseCtoEnvelope(args, cwd);
	if (!envelope.task) return "ERROR: empty task after stripping prefix.";
	const active = findActiveCtoRun(cwd, { sessionId });
	if (active) {
		ctx.ui.notify(`cto: amending run ${active.runId} with: ${envelope.task.slice(0, 50)}`, "info");
		return buildAmendPrompt(envelope, cwd, active, { sessionId });
	}
	ctx.ui.notify(`cto: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
	return buildCtoPrompt(envelope, cwd, { sessionId });
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
