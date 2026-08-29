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

function doWorkDescription(doWork: string, team: string): string {
	return `Run a profile-driven workflow. /${doWork} <task>. (Alias: /${team}.)`;
}
function teamDescription(doWork: string): string {
	return `Alias for /${doWork}. Prefer /${doWork} in new code.`;
}
function ctoDescription(cto: string): string {
	return `CTO sub-orchestration (main-session role): the resident CTO decomposes a task into parallel development teams. /${cto} <task>; /${cto} alone starts STANDBY (tasks arrive via messenger inbox). Runs in-session — never task(agent=cto)`;
}

export interface WorkflowCommandOptions {
	buildDoWorkPrompt?: (envelope: ParsedWorkEnvelope, cwd: string) => string;
	doWorkDescription?: string;
	teamDescription?: string;
	ctoDescription?: string;
	namespace?: string;
	commandPrefix?: string;
	cwd?: string;
	/**
	 * Authoritative cwd override: when configured, its result — including
	 * `undefined` — is used as-is; the context/session fallback only applies
	 * when no resolver is configured.
	 */
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
	variant: "do-work" | "team",
	display: { doWork: string; team: string },
	promptBuilder: (envelope: ParsedWorkEnvelope, cwd: string) => string,
	cwd: string | undefined,
): string {
	const displayName = variant === "do-work" ? display.doWork : display.team;
	if (!args) {
		return variant === "do-work"
			? [
					`Usage: /${display.doWork} <task description>`,
					"",
					"Examples:",
					`  /${display.doWork} Add OAuth authentication with Google and GitHub`,
					`  /${display.doWork} [AUTONOMOUS] Fix the 500 error on /api/users issue=#42`,
					"",
					`Alias: \`/${display.team}\` works too.`,
				].join("\n")
			: [
					`Usage: /${display.team} <task description>  (alias for /${display.doWork})`,
					"",
					"Examples:",
					`  /${display.team} Add OAuth authentication with Google and GitHub`,
					`  /${display.team} [AUTONOMOUS] Fix the 500 error on /api/users issue=#42`,
				].join("\n");
	}

	if (!cwd) return "ERROR: workflow cwd unavailable.";
	const envelope = parseWorkEnvelope(args, cwd);
	if (!envelope.task) return "ERROR: empty task after stripping prefix.";
	ctx.ui.notify(`${displayName}: ${envelope.task.slice(0, 60)} (workflow pending)`, "info");
	return promptBuilder(envelope, cwd);
}

function buildCtoCommandPrompt(args: string, ctx: ExtensionCommandContext, ctoName: string, cwd: string | undefined): string {
	if (!cwd) return "ERROR: workflow cwd unavailable.";
	if (!args) {
		ctx.ui.notify(`${ctoName}: standby mode — awaiting tasks via messenger inbox`, "info");
		return buildStandbyCtoPrompt(cwd);
	}

	const sessionId = ctx.sessionManager.getSessionId();
	const envelope = parseCtoEnvelope(args, cwd);
	if (!envelope.task) return "ERROR: empty task after stripping prefix.";
	const active = findActiveCtoRun(cwd, { sessionId });
	if (active) {
		ctx.ui.notify(`${ctoName}: amending run ${active.runId} with: ${envelope.task.slice(0, 50)}`, "info");
		return buildAmendPrompt(envelope, cwd, active, { sessionId });
	}
	ctx.ui.notify(`${ctoName}: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
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
		// An explicitly configured resolver is authoritative even when it returns
		// undefined (e.g. a marker gate): no fallthrough to the context cwd.
		// The context fallback applies only when no custom resolver is configured.
		if (options.resolveCwd) return options.resolveCwd(ctx);
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
			options.doWorkDescription ?? doWorkDescription(names.doWork, names.team),
			(args, ctx, cwd) => buildDoWorkCommandPrompt(args, ctx, "do-work", names, promptBuilder, cwd),
			resolveEffectiveCwd,
			claimForCommand,
		);
		registerPromptCommand(
			pi,
			names.team,
			options.teamDescription ?? teamDescription(names.doWork),
			(args, ctx, cwd) => buildDoWorkCommandPrompt(args, ctx, "team", names, promptBuilder, cwd),
			resolveEffectiveCwd,
			claimForCommand,
		);
		registerPromptCommand(
			pi,
			names.cto,
			options.ctoDescription ?? ctoDescription(names.cto),
			(args, ctx, cwd) => buildCtoCommandPrompt(args, ctx, names.cto, cwd),
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
