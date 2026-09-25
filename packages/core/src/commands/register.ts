import { resolve as canonicalizeCwd } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	buildAmendPrompt,
	buildCtoPrompt,
	buildStandbyCtoPrompt,
	parseCtoCommand,
	parseEnvelope as parseCtoEnvelope,
} from "./cto.js";
import { acquireCtoIngress, suspendCtoSession, type CtoIngressResult } from "../cto/run.js";
import { buildDoWorkPrompt, parseWorkEnvelope, type ParsedWorkEnvelope } from "./do-work.js";
import { parseWorkflowCommand, type WorkflowCommandMode } from "./envelope.js";
import { createSelectionSnapshot } from "../engine/run-store.js";
import { resolveActiveBranch } from "../engine/state.js";
import { resolveLifecycleIntent } from "../engine/run-lifecycle.js";
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
	return `CTO sub-orchestration (main-session role): the resident CTO decomposes a task into parallel development teams. /${cto} [--run <exact-cto-id>] <task>; /${cto} alone starts STANDBY (tasks arrive via messenger inbox). Registered ingress acquires the exact host claim before the prompt; no latest-run scan. Runs in-session — never task(agent=cto)`;
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
	manager: object;
	sessionFile?: string;
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
	cto?: {
		ingress: CtoIngressResult;
	};
};

type CommandInvocation = {
	commandIntentId?: string;
	/** Natural-language mode is a routing hint, never an explicit command token. */
	inferredMode?: Exclude<WorkflowCommandMode, "list">;
	/** Exact CTO ingress acquired before prompt construction. */
	ctoIngress?: CtoIngressResult;
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
function sameSessionIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
	return (
		left.sessionId === right.sessionId
		&& left.cwd === right.cwd
		&& left.manager === right.manager
		&& (
			left.sessionFile === undefined
			|| right.sessionFile === undefined
			|| left.sessionFile === right.sessionFile
		)
	);
}


function sessionIdentityFromManager(ctx: unknown): SessionIdentity | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const value = ctx as {
		sessionManager?: {
			getCwd?: () => unknown;
			getSessionId?: () => unknown;
			getSessionFile?: () => unknown;
		};
	};
	const manager = value.sessionManager;
	if (!manager || typeof manager !== "object" || typeof manager.getCwd !== "function" || typeof manager.getSessionId !== "function") return undefined;
	try {
		const cwd = canonicalCwd(manager.getCwd());
		const sessionId = manager.getSessionId();
		if (!cwd || typeof sessionId !== "string" || sessionId.length === 0) return undefined;
		const sessionFile = typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined;
		return {
			sessionId,
			cwd,
			manager,
			...(typeof sessionFile === "string" && sessionFile.length > 0 ? { sessionFile } : {}),
		};
	} catch {
		return undefined;
	}
}
function sessionFileFromManager(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
	const explicit = "sessionFile" in ctx && typeof ctx.sessionFile === "string" && ctx.sessionFile.length > 0
		? ctx.sessionFile
		: "session_file" in ctx && typeof ctx.session_file === "string" && ctx.session_file.length > 0
			? ctx.session_file
			: undefined;
	const manager = "sessionManager" in ctx ? ctx.sessionManager : undefined;
	if (manager && typeof manager === "object") {
		if (!("getSessionFile" in manager) || typeof manager.getSessionFile !== "function") return undefined;
		try {
			const file = manager.getSessionFile();
			if (typeof file !== "string" || file.length === 0 || (explicit !== undefined && explicit !== file)) return undefined;
			return file;
		} catch {
			return undefined;
		}
	}
	return explicit;
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
		|| managerIdentity.manager !== binding.identity.manager
		|| managerIdentity.sessionFile !== undefined
			&& binding.identity.sessionFile !== undefined
			&& managerIdentity.sessionFile !== binding.identity.sessionFile
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
	const value = event as { session_id?: unknown };
	return typeof value.session_id === "string" && value.session_id.length > 0 ? value.session_id : undefined;
}

function eventSessionFile(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const value = event as { session_file?: unknown };
	return typeof value.session_file === "string" && value.session_file.length > 0 ? value.session_file : undefined;
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
	const requestedSessionFile = eventSessionFile(event);
	if (requestedSessionFile && requestedSessionFile !== binding.identity.sessionFile) return undefined;
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
	if (!record || !sameSessionIdentity(record, identity) || provenance.get(key) !== record) {
		return undefined;
	}
	provenance.delete(key);
	return record;
}


function deleteTrackedIntentRecord(
	tracked: Map<string, CommandProvenanceRecord>,
	identity: SessionIdentity,
): void {
	const key = provenanceKey(identity);
	const record = tracked.get(key);
	if (record && sameSessionIdentity(record, identity)) tracked.delete(key);
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
	trackedIntentProvenance: Map<string, CommandProvenanceRecord>,
	options: WorkflowCommandOptions,
	ctx: ExtensionCommandContext,
	boundController?: WorkflowSessionController,
	controllerManagers?: WeakMap<WorkflowSessionController, object>,
): void {
	const identity = sessionIdentityFromManager(ctx);
	const record = clearCurrentProvenance(provenance, ctx);
	if (identity) deleteTrackedIntentRecord(trackedIntentProvenance, identity);
	if (record?.intent) return;
	let controller = boundController;
	if (!controller) {
		const binding = identity ? resolveTrustedController(options, ctx, identity.cwd) : undefined;
		controller = binding?.controller;
	}
	if (!controller || !identity || !controllerManagers || controllerManagers.get(controller) !== identity.manager) return;
	try {
		controller.clearCommandIntent();
	} catch {
		// Cleanup must not mask the command's own error path.
	}
}
type CommandPromptBuilder = (
	args: string,
	ctx: ExtensionCommandContext,
	cwd: string | undefined,
	commandIntentId?: string,
	inferredMode?: Exclude<WorkflowCommandMode, "list">,
	ctoIngress?: CtoIngressResult,
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
				prompt = buildPrompt(
					normalizedArgs,
					ctx,
					cwd,
					invocation?.commandIntentId,
					invocation?.inferredMode,
					invocation?.ctoIngress,
				);
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
	inferredMode?: Exclude<WorkflowCommandMode, "list">,
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
	const inferred = !command.explicit_mode ? resolveLifecycleIntent({ text: parsed.task }) : undefined;
	const naturalMode = inferred?.source === "natural_language" ? inferred.mode : undefined;
	const resolvedMode = command.mode ?? inferredMode ?? naturalMode;
	if (command.mode === "new" && !parsed.task) return "ERROR: empty task after stripping prefix.";
	const envelope: ParsedWorkEnvelope = {
		...parsed,
		...(resolvedMode ? { mode: resolvedMode } : {}),
		...(command.run_id ? { run_id: command.run_id } : {}),
		...(commandIntentId ? { command_intent_id: commandIntentId } : {}),
	};
	ctx.ui.notify(`${displayName}: ${envelope.task || envelope.mode || "workflow"} (workflow pending)`, "info");
	return promptBuilder(envelope, cwd);
}

function preflightCtoCommand(args: string): string | undefined {
	const command = parseCtoCommand(args);
	return command.ok ? undefined : `ERROR [${command.code}]: ${command.error}`;
}

function buildCtoCommandPrompt(
	args: string,
	ctx: ExtensionCommandContext,
	ctoName: string,
	cwd: string | undefined,
	_ctoCommandIntentId?: string,
	_ctoInferredMode?: Exclude<WorkflowCommandMode, "list">,
	ingress?: CtoIngressResult,
): string {
	if (!cwd) return "ERROR: workflow cwd unavailable.";
	if (!ingress) return "ERROR [WORKFLOW_CONTEXT_REJECTED]: trusted CTO session is unavailable.";
	const command = parseCtoCommand(args);
	if (!command.ok) return `ERROR [${command.code}]: ${command.error}`;
	const sessionId = ctx.sessionManager.getSessionId();
	const task = command.task || (ingress.state.standby ? "" : ingress.state.task);
	if (!task) {
		ctx.ui.notify(`${ctoName}: standby mode — awaiting tasks via messenger inbox`, "info");
		return buildStandbyCtoPrompt(cwd, { runId: ingress.run_id });
	}
	const envelope = parseCtoEnvelope(task, cwd);
	if (!envelope.task) return "ERROR: empty task after stripping prefix.";
	if (!ingress.created) {
		ctx.ui.notify(`${ctoName}: amending run ${ingress.run_id} with: ${envelope.task.slice(0, 50)}`, "info");
		return buildAmendPrompt(
			envelope,
			cwd,
			{ runId: ingress.run_id, state: ingress.state },
			{ sessionId, runId: ingress.run_id },
		);
	}
	ctx.ui.notify(`${ctoName}: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
	return buildCtoPrompt(envelope, cwd, { sessionId, runId: ingress.run_id });
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
function prepareCtoCommandInvocation(
	provenance: Map<string, CommandProvenanceRecord>,
	trackedIntentProvenance: Map<string, CommandProvenanceRecord>,
	options: WorkflowCommandOptions,
	args: string,
	cwd: string | undefined,
	ctx: ExtensionCommandContext,
	controllerManagers: WeakMap<WorkflowSessionController, object>,
): CommandInvocation {
	const binding = bindCommandController(options, cwd, ctx);
	if (!binding) throw new Error("WORKFLOW_CONTEXT_REJECTED: trusted CTO session is unavailable");
	controllerManagers.set(binding.controller, binding.identity.manager);
	const sessionFile = sessionFileFromManager(ctx);
	if (!sessionFile || binding.identity.sessionFile !== sessionFile) {
		throw new Error("WORKFLOW_CONTEXT_REJECTED: CTO ingress requires the host session file association");
	}
	const command = parseCtoCommand(args);
	if (!command.ok) throw new Error(`ERROR [${command.code}]: ${command.error}`);
	const envelope = parseCtoEnvelope(command.task, binding.identity.cwd);
	const provenanceBindingKey = provenanceKey(binding.identity);
	// Snapshot both exact map entries before any controller call can re-enter
	// another registered command. The map and tracked token are independent CAS
	// guards: a consumed hook may leave provenance empty while replacing the
	// tracked owner with a newer explicit command.
	const predecessorAtAcquire = provenance.get(provenanceBindingKey);
	const trackedAtAcquire = trackedIntentProvenance.get(provenanceBindingKey);
	const predecessor = predecessorAtAcquire && sameSessionIdentity(predecessorAtAcquire, binding.identity)
		? predecessorAtAcquire
		: undefined;
	const trackedPredecessor = trackedAtAcquire && sameSessionIdentity(trackedAtAcquire, binding.identity)
		? trackedAtAcquire
		: undefined;
	const context = binding.controller.context();
	const ingress = acquireCtoIngress({
		cwd: binding.identity.cwd,
		branch: context.branch,
		task: envelope.task,
		...(command.run_id ? { run_id: command.run_id } : {}),
		controller: binding.controller,
	});
	// Compare both ownership slots before mutating either one. No host callback
	// occurs between these reads and the exact-entry deletes below.
	const canReplaceCurrent =
		provenance.get(provenanceBindingKey) === predecessorAtAcquire
		&& trackedIntentProvenance.get(provenanceBindingKey) === trackedAtAcquire
		&& (predecessorAtAcquire === undefined || predecessor !== undefined)
		&& (trackedAtAcquire === undefined || trackedPredecessor !== undefined);
	let canInstallOuter = false;
	if (canReplaceCurrent) {
		if (predecessorAtAcquire !== undefined && provenance.get(provenanceBindingKey) === predecessorAtAcquire) {
			provenance.delete(provenanceBindingKey);
		}
		if (trackedAtAcquire !== undefined && trackedIntentProvenance.get(provenanceBindingKey) === trackedAtAcquire) {
			trackedIntentProvenance.delete(provenanceBindingKey);
		}
		if (predecessor && predecessor !== trackedPredecessor) cleanupIntent(predecessor);
		if (trackedPredecessor) cleanupIntent(trackedPredecessor);
		// cleanupIntent is controller-owned and may re-enter a registered
		// command. Publish the outer record only if both slots stayed empty.
		canInstallOuter =
			provenance.get(provenanceBindingKey) === undefined
			&& trackedIntentProvenance.get(provenanceBindingKey) === undefined;
	}
	const record: CommandProvenanceRecord = {
		...binding.identity,
		controller: binding.controller,
		cto: { ingress },
	};
	if (canInstallOuter) provenance.set(provenanceBindingKey, record);
	return {
		ctoIngress: ingress,
		arm: (prompt: string) => armCommandProvenance(provenance, record, cwd, ctx, prompt),
		cleanup: () => {
			if (provenance.get(provenanceBindingKey) === record) provenance.delete(provenanceBindingKey);
			try {
				suspendCtoSession(binding.controller, "session-replacement");
			} catch {
				// Preserve the original prompt-build/send error.
			}
		},
	};
}


function prepareCommandInvocation(
	provenance: Map<string, CommandProvenanceRecord>,
	trackedIntentProvenance: Map<string, CommandProvenanceRecord>,
	options: WorkflowCommandOptions,
	args: string,
	cwd: string | undefined,
	ctx: ExtensionCommandContext,
	controllerManagers: WeakMap<WorkflowSessionController, object>,
): CommandInvocation | undefined {
	const ownIdentity = sessionIdentityFromManager(ctx);
	let previousHadIntent = false;
	if (ownIdentity) {
		deleteTrackedIntentRecord(trackedIntentProvenance, ownIdentity);
		const previous = deleteExactProvenanceRecord(provenance, ownIdentity);
		previousHadIntent = Boolean(previous?.intent);
		if (previous) cleanupIntent(previous);
	}
	const binding = bindCommandController(options, cwd, ctx);
	if (!binding) return undefined;
	controllerManagers.set(binding.controller, binding.identity.manager);
	const provenanceBindingKey = provenanceKey(binding.identity);
	const command = parseWorkflowCommand(args);
	if (!command.ok || command.mode === "list" || !args) {
		if (!previousHadIntent) binding.controller.clearCommandIntent();
		return undefined;
	}
	const parsedTask = command.explicit_mode ? undefined : parseWorkEnvelope(command.task, cwd!).task;
	const lifecycleIntent = command.explicit_mode
		? undefined
		: resolveLifecycleIntent({ text: parsedTask ?? command.task });
	const inferredMode = lifecycleIntent?.source === "natural_language" ? lifecycleIntent.mode : undefined;
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
		...(inferredMode ? { inferredMode } : {}),
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
	trackedIntentProvenance: Map<string, CommandProvenanceRecord>,
	options: WorkflowCommandOptions,
	ctx: ExtensionCommandContext,
): undefined {
	clearCurrentCommandIngress(provenance, trackedIntentProvenance, options, ctx);
	return undefined;
}
export function registerWorkflowCommands(pi: ExtensionAPI, options: WorkflowCommandOptions = {}): void {
	const provenance = new Map<string, CommandProvenanceRecord>();
	const trackedIntentProvenance = new Map<string, CommandProvenanceRecord>();
	const controllerManagers = new WeakMap<WorkflowSessionController, object>();
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
		const requestedSessionFile = eventSessionFile(event);
		if (requestedSessionFile && requestedSessionFile !== identity.sessionFile) return;
		const requestedCwd = eventCwd(event);
		if (requestedCwd && requestedCwd !== identity.cwd) return;
		deleteExactProvenanceRecord(provenance, identity);
		deleteTrackedIntentRecord(trackedIntentProvenance, identity);
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
			const requestedSessionFile = eventSessionFile(event);
			if (requestedSessionFile && requestedSessionFile !== identity.sessionFile) return undefined;
			const requestedCwd = eventCwd(event);
			if (requestedCwd && requestedCwd !== identity.cwd) return undefined;
			const provenanceBindingKey = provenanceKey(identity);
			const record = provenance.get(provenanceBindingKey);
			if (
				!record
				|| record.prompt === undefined
				|| provenance.get(provenanceBindingKey) !== record
				|| record.manager !== identity.manager
			) return undefined;
			// Once an exact identity has a candidate prompt, consume that
			// one-shot record before any controller authorization. A forged or
			// replaced controller must fail closed without leaving a replayable
			// prompt behind. Successful consumption is tracked privately so a
			// later CTO ingress can clear only this exact pending intent.
			provenance.delete(provenanceBindingKey);
			deleteTrackedIntentRecord(trackedIntentProvenance, identity);
			if (record.prompt !== incoming.prompt) {
				cleanupIntent(record);
				return undefined;
			}
			const binding = resolveTrustedEventController(options, event, ctx, resolveEffectiveCwd);
			if (
				!binding
				|| binding.controller !== record.controller
				|| binding.identity.manager !== identity.manager
				|| provenanceKey(binding.identity) !== provenanceBindingKey
			) {
				cleanupIntent(record);
				return undefined;
			}
			if (record.intent) trackedIntentProvenance.set(provenanceBindingKey, record);
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
			(args, ctx, cwd, commandIntentId, inferredMode) => buildDoWorkCommandPrompt(args, ctx, "do-work", names, promptBuilder, cwd, commandIntentId, inferredMode),
			resolveEffectiveCwd,
			(args, cwd, ctx) => {
				claimForCommand?.(cwd);
				return prepareCommandInvocation(provenance, trackedIntentProvenance, options, args, cwd, ctx, controllerManagers);
			},
			preflightWorkflowCommand,
			(ctx) => clearCurrentCommandIngress(provenance, trackedIntentProvenance, options, ctx, undefined, controllerManagers),
		);
		registerPromptCommand(
			pi,
			names.team,
			options.teamDescription ?? teamDescription(names.doWork),
			(args, ctx, cwd, commandIntentId, inferredMode) => buildDoWorkCommandPrompt(args, ctx, "team", names, promptBuilder, cwd, commandIntentId, inferredMode),
			resolveEffectiveCwd,
			(args, cwd, ctx) => {
				claimForCommand?.(cwd);
				return prepareCommandInvocation(provenance, trackedIntentProvenance, options, args, cwd, ctx, controllerManagers);
			},
			preflightWorkflowCommand,
			(ctx) => clearCurrentCommandIngress(provenance, trackedIntentProvenance, options, ctx, undefined, controllerManagers),
		);
		registerPromptCommand(
			pi,
			names.cto,
			options.ctoDescription ?? ctoDescription(names.cto),
			(args, ctx, cwd, commandIntentId, inferredMode, ingress) =>
				buildCtoCommandPrompt(args, ctx, names.cto, cwd, commandIntentId, inferredMode, ingress),
			resolveEffectiveCwd,
			(args, cwd, ctx) => {
				claimForCommand?.(cwd);
				return prepareCtoCommandInvocation(provenance, trackedIntentProvenance, options, args, cwd, ctx, controllerManagers);
			},
			preflightCtoCommand,
			(ctx) => clearCurrentCommandIngress(provenance, trackedIntentProvenance, options, ctx, undefined, controllerManagers),
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
