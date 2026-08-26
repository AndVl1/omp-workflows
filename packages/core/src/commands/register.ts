import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	buildAmendPrompt,
	buildCtoPrompt,
	buildStandbyCtoPrompt,
	findActiveCtoRun,
	parseEnvelope as parseCtoEnvelope,
} from "./cto.js";
import { buildDoWorkPrompt, parseWorkEnvelope, type ParsedWorkEnvelope } from "./do-work.js";
import {
	claimWorkflowOwners,
	type WorkflowOwnerSource,
} from "../index.js";

const DO_WORK_DESCRIPTION = "Run a profile-driven workflow. /do-work <task>. (Alias: /team.)";
const TEAM_DESCRIPTION = "Alias for /do-work. Prefer /do-work in new code.";
const CTO_DESCRIPTION =
	"CTO sub-orchestration (main-session role): the resident CTO decomposes a task into parallel development teams. /cto <task>; /cto alone starts STANDBY (tasks arrive via messenger inbox). Runs in-session — never task(agent=cto)";

export interface WorkflowCommandOptions {
	buildDoWorkPrompt?: (envelope: ParsedWorkEnvelope, cwd: string) => string;
	doWorkDescription?: string;
	teamDescription?: string;
	ctoDescription?: string;
	namespace?: string;
	commandPrefix?: string;
	cwd?: string;
	resolveCwd?: (ctx: unknown) => string | undefined;
	owner?: WorkflowOwnerSource;
}
/**
 * Resolve the project root from the session manager first. A missing cwd is
 * returned as unavailable rather than silently switching to process.cwd().
 */
export function resolveCommandCwd(ctx: ExtensionCommandContext): string | undefined {
	const sessionManager = ctx.sessionManager as unknown as { getCwd?: () => unknown } | undefined;
	try {
		const sessionCwd = sessionManager?.getCwd?.();
		if (typeof sessionCwd === "string" && sessionCwd.length > 0) return sessionCwd;
	} catch {
		// Fall through to the context cwd.
	}
	return typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : undefined;
}

type CommandPromptBuilder = (
	args: string,
	ctx: ExtensionCommandContext,
	cwd: string | undefined,
) => string;
type BeforeCommandExecute = (cwd: string | undefined) => void;

function registerPromptCommand(
	pi: ExtensionAPI,
	name: string,
	description: string,
	buildPrompt: CommandPromptBuilder,
	resolveCwd: (ctx: ExtensionCommandContext) => string | undefined,
	beforeExecute?: BeforeCommandExecute,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			// Resolve once and pass this exact value through both authorization and
			// prompt construction. The context may drift while a session is active.
			const cwd = resolveCwd(ctx);
			beforeExecute?.(cwd);
			pi.sendUserMessage(buildPrompt(args.trim(), ctx, cwd));
		},
	});
}

function buildDoWorkCommandPrompt(
	args: string,
	ctx: ExtensionCommandContext,
	commandName: "do-work" | "team",
	promptBuilder: (envelope: ParsedWorkEnvelope, cwd: string) => string,
	cwd: string | undefined,
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

	if (!cwd) return "ERROR: workflow cwd unavailable.";
	const envelope = parseWorkEnvelope(args, cwd);
	if (!envelope.task) return "ERROR: empty task after stripping prefix.";
	ctx.ui.notify(`${commandName}: ${envelope.task.slice(0, 60)} (workflow pending)`, "info");
	return promptBuilder(envelope, cwd);
}

function buildCtoCommandPrompt(args: string, ctx: ExtensionCommandContext, cwd: string | undefined): string {
	if (!cwd) return "ERROR: workflow cwd unavailable.";
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
function commandName(prefix: string | undefined, base: "do-work" | "team" | "cto"): string {
	if (!prefix) return base;
	if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw new Error(`invalid command namespace '${prefix}'`);
	return `${prefix}-${base}`;
}

function claimCommandOwner(options: WorkflowCommandOptions, cwd: string): void {
	if (!options.owner) return;
	const owner = typeof options.owner === "function" ? options.owner(cwd) : options.owner;
	const claim = claimWorkflowOwners(cwd, ["workflow_registration"], owner);
	if (!claim.ok) throw new Error(`${claim.code}: ${claim.error}`);
}

/** Register workflow entry points during extension load, before OMP snapshots slash suggestions. */
export function registerWorkflowCommands(pi: ExtensionAPI, options: WorkflowCommandOptions = {}): void {
	const prefix = options.commandPrefix ?? options.namespace;
	const names = {
		doWork: commandName(prefix, "do-work"),
		team: commandName(prefix, "team"),
		cto: commandName(prefix, "cto"),
	};
	const promptBuilder = options.buildDoWorkPrompt ?? buildDoWorkPrompt;
	const resolveEffectiveCwd = (ctx: ExtensionCommandContext): string | undefined => {
		if (options.cwd !== undefined) return options.cwd;
		const resolvedCwd = options.resolveCwd?.(ctx);
		if (resolvedCwd !== undefined) return resolvedCwd;
		return resolveCommandCwd(ctx);
	};
	const claimForCommand = options.owner
		? (cwd: string | undefined): void => {
			if (!cwd) throw new Error("workflow cwd unavailable.");
			claimCommandOwner(options, cwd);
		}
		: undefined;
	let registered = false;
	const registerCommands = (): void => {
		if (registered) return;
		registered = true;
		registerPromptCommand(
			pi,
			names.doWork,
			options.doWorkDescription ?? DO_WORK_DESCRIPTION,
			(args, ctx, cwd) => buildDoWorkCommandPrompt(args, ctx, "do-work", promptBuilder, cwd),
			resolveEffectiveCwd,
			claimForCommand,
		);
		registerPromptCommand(
			pi,
			names.team,
			options.teamDescription ?? TEAM_DESCRIPTION,
			(args, ctx, cwd) => buildDoWorkCommandPrompt(args, ctx, "team", promptBuilder, cwd),
			resolveEffectiveCwd,
			claimForCommand,
		);
		registerPromptCommand(
			pi,
			names.cto,
			options.ctoDescription ?? CTO_DESCRIPTION,
			(args, ctx, cwd) => buildCtoCommandPrompt(args, ctx, cwd),
			resolveEffectiveCwd,
			claimForCommand,
		);
	};

	if (options.cwd) {
		claimCommandOwner(options, options.cwd);
		registerCommands();
		return;
	}

	// Publish the complete base inventory during extension load. OMP snapshots
	// registered commands before session_start, and a later extension can still
	// replace an entry with the same canonical name in the host's command map.
	registerCommands();
	if (!options.owner || typeof pi.on !== "function") return;

	// The session root is unavailable during extension load, so claim the
	// owner once the session supplies its root. Command handlers repeat this
	// check to remain fail-closed if a conflicting owner wins the claim.
	pi.on("session_start", (_event: unknown, ctx: unknown) => {
		const cwd = resolveEffectiveCwd(ctx as ExtensionCommandContext);
		if (!cwd) return;
		claimCommandOwner(options, cwd);
	});
}
