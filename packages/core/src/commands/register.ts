import { resolve as canonicalizeCwd } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	buildAmendPrompt,
	buildCtoPrompt,
	buildStandbyCtoPrompt,
	findActiveCtoRun,
	parseEnvelope as parseCtoEnvelope,
} from "./cto.js";
import { buildDoWorkPrompt, parseWorkEnvelope, type ParsedWorkEnvelope } from "./do-work.js";
import { parseWorkflowCommand } from "./envelope.js";
import { createSelectionSnapshot } from "../engine/run-store.js";
import { resolveActiveBranch } from "../engine/state.js";
import type { WorkflowSessionController } from "../engine/host-controller.js";
import type { TrustedExecutionContext } from "../engine/types.js";
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
	/** Reuse the bundle-owned controller shared with core workflow tools/hooks. */
	getSessionController?: (ctx: unknown, cwd: string) => WorkflowSessionController | undefined;
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

type SessionIdentity = {
	sessionId: string;
	cwd: string;
};

type TrustedControllerBinding = {
	controller: WorkflowSessionController;
	identity: SessionIdentity;
};

type CommandIntentOwnership = {
	intent_id: string;
	mode: "new" | "resume" | "rework";
	run_id?: string;
};

type CommandProvenanceRecord = SessionIdentity & {
	controller: WorkflowSessionController;
	prompt?: string;
	intent?: CommandIntentOwnership;
};

type CommandInvocation = {
	commandIntentId?: string;
	/** Removes this invocation's record and, if owned, its exact intent. */
	cleanup?: () => void;
	/** Arms the same ingress record after the exact prompt has been built. */
	arm?: (prompt: string) => void;
};

/**
 * Narrow, private context for the one turn caused by a registered workflow
 * command. It requests managed execution; only the current engine-returned
 * workflow handoff authorizes dispatch, and all safety/operator/human gates
 * remain mandatory.
 */
const WORKFLOW_TURN_CONTRACT = [
	"Private scoped registered-workflow invocation (this turn only): request managed execution for the current engine workflow_begin single-worker or consilium handoff, even when a generic small-slice efficiency heuristic would discourage delegation. This request does not authorize dispatch; only the current engine-returned workflow_begin handoff does.",
	"Use the exact current engine handoff, roster, and count; the current marker, cursor, epoch, and capability must be carried through, and every dispatch gate remains mandatory.",
	"Never use this scope for arbitrary or classification delegation, direct edits, nested or worker re-delegation, stale capabilities, or any safety/operator ban or human checkpoint override.",
].join(" ");

function canonicalCwd(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		return canonicalizeCwd(value);
	} catch {
		return undefined;
	}
}
function provenanceKey(identity: SessionIdentity): string {
	return `${identity.sessionId}\u0000${identity.cwd}`;
}

function sessionIdentityFromManager(ctx: unknown): SessionIdentity | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const value = ctx as {
		sessionManager?: {
			getCwd?: () => unknown;
			getSessionId?: () => unknown;
		};
	};
	const manager = value.sessionManager;
	if (!manager || typeof manager.getCwd !== "function" || typeof manager.getSessionId !== "function") return undefined;
	try {
		const cwd = canonicalCwd(manager.getCwd());
		const sessionId = manager.getSessionId();
		if (!cwd || typeof sessionId !== "string" || sessionId.length === 0) return undefined;
		return { sessionId, cwd };
	} catch {
		return undefined;
	}
}

function controllerMatchesIdentity(
	binding: TrustedControllerBinding,
	cwd: string | undefined,
	ctx: unknown,
): boolean {
	const requestedCwd = canonicalCwd(cwd);
	const managerIdentity = sessionIdentityFromManager(ctx);
	if (!requestedCwd || !managerIdentity) return false;
	if (
		requestedCwd !== binding.identity.cwd
		|| managerIdentity.sessionId !== binding.identity.sessionId
		|| managerIdentity.cwd !== binding.identity.cwd
	) return false;
	try {
		const context = binding.controller.context();
		return (
			context.session_id === binding.identity.sessionId
			&& canonicalCwd(context.worktree) === binding.identity.cwd
		);
	} catch {
		return false;
	}
}

/**
 * Resolve a bundle-owned controller only when the independently supplied
 * session manager identity agrees with both the requested cwd and controller
 * context. The safe variant is used by hooks so an unbound/headless event
 * cannot consume another session's provenance.
 */
function resolveTrustedController(
	options: WorkflowCommandOptions,
	ctx: unknown,
	cwd: string | undefined,
): TrustedControllerBinding | undefined {
	if (!options.getSessionController || !cwd) return undefined;
	const requestedCwd = canonicalCwd(cwd);
	const managerIdentity = sessionIdentityFromManager(ctx);
	if (!requestedCwd || !managerIdentity || requestedCwd !== managerIdentity.cwd) return undefined;
	let controller: WorkflowSessionController | undefined;
	try {
		controller = options.getSessionController(ctx, cwd);
	} catch {
		return undefined;
	}
	if (!controller) return undefined;
	let context: TrustedExecutionContext;
	try {
		context = controller.context();
	} catch {
		return undefined;
	}
	if (
		context.session_id !== managerIdentity.sessionId
		|| canonicalCwd(context.worktree) !== managerIdentity.cwd
	) return undefined;
	return {
		controller,
		identity: managerIdentity,
	};
}
function eventSessionId(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const value = event as { session_id?: unknown; sessionId?: unknown };
	if (typeof value.session_id === "string" && value.session_id.length > 0) return value.session_id;
	return typeof value.sessionId === "string" && value.sessionId.length > 0 ? value.sessionId : undefined;
}

function eventCwd(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const value = event as { cwd?: unknown };
	return canonicalCwd(value.cwd);
}

function resolveTrustedEventController(
	options: WorkflowCommandOptions,
	event: unknown,
	ctx: unknown,
	resolveCwd: (ctx: ExtensionCommandContext) => string | undefined,
): TrustedControllerBinding | undefined {
	if (!options.getSessionController || !ctx || typeof ctx !== "object") return undefined;
	const commandContext = ctx as ExtensionCommandContext;
	let cwd: string | undefined;
	try {
		cwd = resolveCwd(commandContext);
	} catch {
		return undefined;
	}
	const binding = resolveTrustedController(options, ctx, cwd);
	if (!binding) return undefined;
	const requestedSessionId = eventSessionId(event);
	if (requestedSessionId && requestedSessionId !== binding.identity.sessionId) return undefined;
	const requestedCwd = eventCwd(event);
	if (requestedCwd && requestedCwd !== binding.identity.cwd) return undefined;
	return binding;
}
function armCommandProvenance(
	provenance: Map<string, CommandProvenanceRecord>,
	record: CommandProvenanceRecord,
	cwd: string | undefined,
	ctx: unknown,
	prompt: string,
): void {
	if (
		provenance.get(provenanceKey(record)) !== record
		|| !controllerMatchesIdentity({ controller: record.controller, identity: record }, cwd, ctx)
	) {
		return;
	}
	record.prompt = prompt;
}

function cleanupIntent(record: CommandProvenanceRecord): void {
	const intent = record.intent;
	if (!intent) return;
	try {
		const consumed = record.controller.consumeCommandIntent({
			command_intent_id: intent.intent_id,
			mode: intent.mode,
			...(intent.run_id ? { run_id: intent.run_id } : {}),
		});
		if (consumed?.intent_id === intent.intent_id) record.controller.commitCommandIntent(intent.intent_id);
	} catch {
		// A newer or already-consumed intent owns the controller.
	}
}

function deleteExactProvenanceRecord(
	provenance: Map<string, CommandProvenanceRecord>,
	identity: SessionIdentity,
): CommandProvenanceRecord | undefined {
	const key = provenanceKey(identity);
	const record = provenance.get(key);
	if (!record || record.sessionId !== identity.sessionId || record.cwd !== identity.cwd || provenance.get(key) !== record) {
		return undefined;
	}
	provenance.delete(key);
	return record;
}

function clearCurrentProvenance(
	provenance: Map<string, CommandProvenanceRecord>,
	ctx: unknown,
): CommandProvenanceRecord | undefined {
	const identity = sessionIdentityFromManager(ctx);
	if (!identity) return undefined;
	const record = deleteExactProvenanceRecord(provenance, identity);
	if (record) cleanupIntent(record);
	return record;
}

function clearCurrentCommandIngress(
	provenance: Map<string, CommandProvenanceRecord>,
	options: WorkflowCommandOptions,
	ctx: ExtensionCommandContext,
	boundController?: WorkflowSessionController,
): void {
	const record = clearCurrentProvenance(provenance, ctx);
	if (record?.intent) return;
	let controller = boundController;
	if (!controller) {
		const identity = sessionIdentityFromManager(ctx);
		const binding = identity ? resolveTrustedController(options, ctx, identity.cwd) : undefined;
		controller = binding?.controller;
	}
	try {
		controller?.clearCommandIntent();
	} catch {
		// Cleanup must not mask the command's own error path.
	}
}
type CommandPromptBuilder = (
	args: string,
	ctx: ExtensionCommandContext,
	cwd: string | undefined,
	commandIntentId?: string,
) => string;
type BeforeCommandExecute = (
	args: string,
	cwd: string | undefined,
	ctx: ExtensionCommandContext,
) => CommandInvocation | undefined;

function registerPromptCommand(
	pi: ExtensionAPI,
	name: string,
	description: string,
	buildPrompt: CommandPromptBuilder,
	resolveCwd: (ctx: ExtensionCommandContext) => string | undefined,
	beforeExecute?: BeforeCommandExecute,
	preflight?: (args: string) => string | undefined,
	clearPending?: (ctx: ExtensionCommandContext) => void,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			const normalizedArgs = args.trim();
			const preflightError = preflight?.(normalizedArgs);
			if (preflightError) {
				clearPending?.(ctx);
				pi.sendUserMessage(preflightError);
				return;
			}
			// Resolve once and pass this exact value through both authorization and
			// prompt construction. The context may drift while a session is active.
			const cwd = resolveCwd(ctx);
			const invocation = beforeExecute?.(normalizedArgs, cwd, ctx);
			let prompt: string;
			try {
				prompt = buildPrompt(normalizedArgs, ctx, cwd, invocation?.commandIntentId);
			} catch (error) {
				try {
					invocation?.cleanup?.();
				} catch {
					// Preserve the prompt-build error.
				}
				throw error;
			}
			try {
				// Provenance is armed in-place only after the exact prompt exists.
				invocation?.arm?.(prompt);
				pi.sendUserMessage(prompt);
			} catch (error) {
				try {
					invocation?.cleanup?.();
				} catch {
					// Preserve the synchronous send error.
				}
				throw error;
			}
		},
	});
}

function preflightWorkflowCommand(args: string): string | undefined {
	const command = parseWorkflowCommand(args);
	if (command.ok) return undefined;
	return `ERROR [${command.code}]: ${command.error}`;
}

function buildDoWorkCommandPrompt(
	args: string,
	ctx: ExtensionCommandContext,
	variant: "do-work" | "team",
	display: { doWork: string; team: string },
	promptBuilder: (envelope: ParsedWorkEnvelope, cwd: string) => string,
	cwd: string | undefined,
	commandIntentId?: string,
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
	const command = parseWorkflowCommand(args);
	if (!command.ok) return `ERROR [${command.code}]: ${command.error}`;
	if (command.mode === "list") {
		const snapshot = createSelectionSnapshot(cwd, { includeTerminal: true, ...(command.all_branches ? {} : { branch: resolveActiveBranch(cwd) }) });
		if (snapshot.candidates.length === 0) return "No workflow runs found.";
		return snapshot.candidates.map((candidate, index) => String(index + 1) + ". " + candidate.title + " — " + candidate.branch + " — " + candidate.status + " — " + candidate.stage + " (snapshot_id=" + snapshot.snapshot_id + "; index=" + index + "; run_id=" + candidate.run_id + ")").join("\n");
	}
	const parsed = parseWorkEnvelope(command.task, cwd);
	if (command.mode === "new" && !parsed.task) return "ERROR: empty task after stripping prefix.";
	const envelope: ParsedWorkEnvelope = {
		...parsed,
		mode: command.mode,
		...(command.run_id ? { run_id: command.run_id } : {}),
		...(commandIntentId ? { command_intent_id: commandIntentId } : {}),
	};
	ctx.ui.notify(`${displayName}: ${envelope.task || command.mode} (workflow pending)`, "info");
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

function bindCommandController(
	options: WorkflowCommandOptions,
	cwd: string | undefined,
	ctx: ExtensionCommandContext,
): TrustedControllerBinding | undefined {
	if (!options.getSessionController) return undefined;
	if (!cwd) throw new Error("WORKFLOW_CONTEXT_REJECTED: workflow cwd unavailable");
	const binding = resolveTrustedController(options, ctx, cwd);
	if (!binding) throw new Error("WORKFLOW_CONTEXT_REJECTED: trusted session identity is unavailable");
	return binding;
}

function prepareCommandInvocation(
	provenance: Map<string, CommandProvenanceRecord>,
	options: WorkflowCommandOptions,
	args: string,
	cwd: string | undefined,
	ctx: ExtensionCommandContext,
): CommandInvocation | undefined {
	const ownIdentity = sessionIdentityFromManager(ctx);
	let previousHadIntent = false;
	if (ownIdentity) {
		const previous = deleteExactProvenanceRecord(provenance, ownIdentity);
		previousHadIntent = Boolean(previous?.intent);
		if (previous) cleanupIntent(previous);
	}
	const binding = bindCommandController(options, cwd, ctx);
	if (!binding) return undefined;
	const provenanceBindingKey = provenanceKey(binding.identity);
	const command = parseWorkflowCommand(args);
	if (!command.ok || command.mode === "list" || !args) {
		if (!previousHadIntent) binding.controller.clearCommandIntent();
		return undefined;
	}
	let commandIntentId: string | undefined;
	let intent: CommandIntentOwnership | undefined;
	if (command.explicit_mode && command.mode) {
		commandIntentId = binding.controller.issueCommandIntent(command.mode, command.run_id).intent_id;
		intent = {
			intent_id: commandIntentId,
			mode: command.mode,
			...(command.run_id ? { run_id: command.run_id } : {}),
		};
	} else if (!previousHadIntent) {
		binding.controller.clearCommandIntent();
	}
	const record: CommandProvenanceRecord = {
		...binding.identity,
		controller: binding.controller,
		...(intent ? { intent } : {}),
	};
	provenance.set(provenanceBindingKey, record);
	return {
		commandIntentId,
		arm: (prompt: string) => armCommandProvenance(provenance, record, cwd, ctx, prompt),
		cleanup: () => {
			if (provenance.get(provenanceBindingKey) === record) provenance.delete(provenanceBindingKey);
			cleanupIntent(record);
		},
	};
}

function readBeforeAgentStartEvent(event: unknown): { prompt: string; systemPrompt: string[] } | undefined {
	if (!event || typeof event !== "object") return undefined;
	const value = event as Record<string, unknown>;
	const prompt = value.prompt;
	const systemPrompt = value.systemPrompt;
	if (typeof prompt !== "string" || !Array.isArray(systemPrompt)) return undefined;
	if (!systemPrompt.every((entry) => typeof entry === "string")) return undefined;
	return { prompt, systemPrompt: systemPrompt as string[] };
}
function clearCommandIntent(
	provenance: Map<string, CommandProvenanceRecord>,
	options: WorkflowCommandOptions,
	ctx: ExtensionCommandContext,
): undefined {
	clearCurrentCommandIngress(provenance, options, ctx);
	return undefined;
}
export function registerWorkflowCommands(pi: ExtensionAPI, options: WorkflowCommandOptions = {}): void {
	const provenance = new Map<string, CommandProvenanceRecord>();
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
	const clearOwnProvenance = (event: unknown, ctx: unknown): void => {
		const identity = sessionIdentityFromManager(ctx);
		if (!identity) return;
		const requestedSessionId = eventSessionId(event);
		if (requestedSessionId && requestedSessionId !== identity.sessionId) return;
		const requestedCwd = eventCwd(event);
		if (requestedCwd && requestedCwd !== identity.cwd) return;
		deleteExactProvenanceRecord(provenance, identity);
	};
	const registerProvenanceHooks = (): void => {
		if (typeof pi.on !== "function") return;
		pi.on("before_agent_start", (event: unknown, ctx: unknown) => {
			const incoming = readBeforeAgentStartEvent(event);
			if (!incoming) return undefined;
			const identity = sessionIdentityFromManager(ctx);
			if (!identity) return undefined;
			const requestedSessionId = eventSessionId(event);
			if (requestedSessionId && requestedSessionId !== identity.sessionId) return undefined;
			const requestedCwd = eventCwd(event);
			if (requestedCwd && requestedCwd !== identity.cwd) return undefined;
			const record = provenance.get(provenanceKey(identity));
			if (!record || record.prompt === undefined || provenance.get(provenanceKey(identity)) !== record) return undefined;
			provenance.delete(provenanceKey(identity));
			if (record.prompt !== incoming.prompt) {
				cleanupIntent(record);
				return undefined;
			}
			const binding = resolveTrustedEventController(options, event, ctx, resolveEffectiveCwd);
			if (!binding || binding.controller !== record.controller || provenanceKey(binding.identity) !== provenanceKey(identity)) {
				cleanupIntent(record);
				return undefined;
			}
			return { systemPrompt: [...incoming.systemPrompt, WORKFLOW_TURN_CONTRACT] };
		});
		pi.on("session_stop", clearOwnProvenance);
		pi.on("session_shutdown", clearOwnProvenance);
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
			(args, ctx, cwd, commandIntentId) => buildDoWorkCommandPrompt(args, ctx, "do-work", names, promptBuilder, cwd, commandIntentId),
			resolveEffectiveCwd,
			(args, cwd, ctx) => {
				claimForCommand?.(cwd);
				return prepareCommandInvocation(provenance, options, args, cwd, ctx);
			},
			preflightWorkflowCommand,
			(ctx) => clearCurrentCommandIngress(provenance, options, ctx),
		);
		registerPromptCommand(
			pi,
			names.team,
			options.teamDescription ?? teamDescription(names.doWork),
			(args, ctx, cwd, commandIntentId) => buildDoWorkCommandPrompt(args, ctx, "team", names, promptBuilder, cwd, commandIntentId),
			resolveEffectiveCwd,
			(args, cwd, ctx) => {
				claimForCommand?.(cwd);
				return prepareCommandInvocation(provenance, options, args, cwd, ctx);
			},
			preflightWorkflowCommand,
			(ctx) => clearCurrentCommandIngress(provenance, options, ctx),
		);
		registerPromptCommand(
			pi,
			names.cto,
			options.ctoDescription ?? ctoDescription(names.cto),
			(args, ctx, cwd) => buildCtoCommandPrompt(args, ctx, names.cto, cwd),
			resolveEffectiveCwd,
			(_args, cwd, ctx) => { claimForCommand?.(cwd); return clearCommandIntent(provenance, options, ctx); },
		);
	};

	if (options.cwd) {
		claimCommandOwner(options, options.cwd);
		registerCommands();
		registerProvenanceHooks();
		return;
	}

	// Publish the complete base inventory during extension load. OMP snapshots
	// registered commands before session_start, and a later extension can still
	// replace an entry with the same canonical name in the host's command map.
	registerCommands();
	registerProvenanceHooks();
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
