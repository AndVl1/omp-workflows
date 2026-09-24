/**
 * @andvl1/omp-workflows-internal — private OMP bundle.
 *
 * Activation contract (frozen):
 *   bundle_id         @andvl1/omp-workflows-internal
 *   owner_kind        private_omp
 *   activation_marker workspace:package.json+packages/core+packages/fullstack
 *   host_range        >=17.3 <19
 *
 * The extension loads in every host but performs workflow-engine registration
 * ONLY when the session project root carries ALL THREE workspace markers
 * (package.json + packages/core/ + packages/fullstack/) AND the atomic owner
 * claim over `workflow_registration` / `workflow_tools` / `config_writer`
 * succeeds. Missing markers and owner conflicts (owner_conflict /
 * owner_invalid) both fail closed BEFORE any side effect: no tools, no gates,
 * no runtime config, no label. Only this package's own diagnostic command
 * `/omp-workflow-team` is always registered — it is the surface that reports
 * WHY activation did or did not happen.
 *
 * Command surface: the always-registered diagnostic command
 * `omp-workflow-team` (its `validate` mode is strictly read-only) plus the
 * core registration surface namespaced as `omp-do-work` / `omp-team` /
 * `omp-cto`. The namespaced descriptors publish eagerly during extension
 * load for slash-discovery, but they are marker-gated: outside a marked
 * internal workspace the resolver yields no cwd and the gated owner source
 * refuses to claim, so session_start and handlers register ZERO owners.
 * Bare `do-work` / `team` / `cto` names are never registered (they belong
 * to the external fullstack plugin) and `omp-model-roles` is never shadowed.
 */

import { resolve } from "node:path";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	buildDoWorkPrompt,
	claimWorkflowOwners,
	createWorkflowReadSelector,
	createWorkflowSessionController,
	createWorkflowToolAdapter,
	parseWorkEnvelope,
	parseWorkflowCommand,
	registerTeamWorkflow,
	registerWorkflowCommands,
	resolveActiveBranch,
	runTarget,
	suspendCtoSession,
	writeRuntimeConfig,
	workflowOwnerFor,
	type RegisterOptions,
	type TrustedExecutionContext,
	type TrustedToolCallResolution,
	type WorkflowCapability,
	type WorkflowSessionController,
	type WorkflowToolAdapter,
} from "@andvl1/omp-workflows-core";

import { detectWorkspaceMarkers } from "./activation.js";
import {
	OMP_INTERNAL_ACTIVATION_MARKER,
	OMP_INTERNAL_BUNDLE_ID,
	OMP_INTERNAL_OWNER_KIND,
	privateOmpOwnerForCwd,
	privateOmpOwnerForMarkedWorkspace,
} from "./identity.js";
import {
	ALLOWED_POOL_AGENTS,
	defaultOmpInternalFlags,
	defaultOmpInternalRoles,
	defaultOmpInternalScopeMap,
	defaultOmpInternalScopeRuntimeClasses,
	defaultOmpInternalScopeUiClasses,
	refreshInternalAgentMappings,
	waitForInternalAgentMappings,
} from "./pool.js";
import { loadOmpWorkflowProfiles } from "./profiles.js";

const ALL_CAPABILITIES: readonly WorkflowCapability[] = [
	"workflow_registration",
	"workflow_tools",
	"config_writer",
];

const COMMAND_NAME = "omp-workflow-team";

/** Namespace for the core registration surface exposed by this bundle. */
const COMMAND_NAMESPACE = "omp";

/**
 * Namespace-aware descriptions. Core ships bare-command copy (`/do-work`,
 * `/team`); under the `omp` namespace the discovery surface must advertise
 * the names this bundle actually registers.
 */
const NAMESPACED_DESCRIPTIONS = {
	doWorkDescription: "Run a profile-driven workflow. /omp-do-work <task>. (Alias: /omp-team.)",
	teamDescription: "Alias for /omp-do-work. Prefer /omp-do-work in new code.",
	ctoDescription:
		"CTO sub-orchestration (main-session role): the resident CTO decomposes a task into parallel development teams. /omp-cto [--run <exact-cto-id>] <task>; /omp-cto alone starts STANDBY (tasks arrive via messenger inbox). Managed suspension preserves pending work across verified session replacement/shutdown. Runs in-session — never task(agent=cto)",
} as const;

interface InternalSessionBinding {
	cwd: string;
	interactive: boolean;
	mode: "tui" | "rpc";
	sessionId?: string;
	sessionManager?: object;
	sessionFile?: string;
	controller?: WorkflowSessionController;
}

/**
 * The bundle owns one trusted controller per host extension instance/session.
 * The mapping is deliberately process-local: it is only an adapter seam and
 * never a source of run authority. Core's canonical controller/read APIs own
 * run selection and lifecycle mutation.
 */
const sessionBindings = new WeakMap<object, InternalSessionBinding>();

function sessionIdFromContext(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const objectContext = ctx as { session_id?: unknown; sessionId?: unknown; sessionManager?: unknown };
	const manager = objectContext.sessionManager;
	if (manager && typeof manager === "object" && "getSessionId" in manager && typeof manager.getSessionId === "function") {
		try {
			const sessionManager = manager as { getSessionId: () => unknown };
			const sessionId = sessionManager.getSessionId();
			if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
		} catch {
			// Fall through to the host context fields.
		}
	}
	const sessionId = objectContext.session_id ?? objectContext.sessionId;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function sessionManagerFromContext(ctx: unknown): object | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const manager = (ctx as { sessionManager?: unknown }).sessionManager;
	if (!manager || typeof manager !== "object") return undefined;
	const value = manager as { getCwd?: unknown; getSessionId?: unknown };
	return typeof value.getCwd === "function" && typeof value.getSessionId === "function"
		? manager
		: undefined;
}

function sessionFileFromManager(manager: object | undefined): string | undefined {
	if (!manager) return undefined;
	const value = manager as { getSessionFile?: () => unknown };
	if (typeof value.getSessionFile !== "function") return undefined;
	try {
		const sessionFile = value.getSessionFile();
		return typeof sessionFile === "string" && sessionFile.length > 0 ? sessionFile : undefined;
	} catch {
		return undefined;
	}
}

function trustedInteractiveSession(ctx: unknown): boolean {
	if (!ctx || typeof ctx !== "object") return false;
	const host = ctx as { mode?: unknown; hasUI?: unknown };
	return host.hasUI === true && (host.mode === "tui" || host.mode === "rpc");
}

/**
 * Host callbacks omit `actor`; an explicit actor is trusted only when it is
 * the orchestrator. Worker/lead/unknown labels cannot borrow host authority.
 */
function trustedHostActor(ctx: unknown): boolean {
	if (!ctx || typeof ctx !== "object") return false;
	const value = ctx as Record<string, unknown>;
	if (!("actor" in value)) return true;
	return value.actor === undefined || value.actor === "orchestrator";
}


interface SessionIdentity {
	cwd?: string;
	sessionId?: string;
	managerBacked?: boolean;
}

function sessionIdentityFromValue(value: unknown): SessionIdentity | undefined {
	if (!value || typeof value !== "object") return undefined;
	const objectValue = value as {
		cwd?: unknown;
		session_id?: unknown;
		sessionId?: unknown;
		sessionManager?: unknown;
	};
	const explicitCwd = typeof objectValue.cwd === "string" && objectValue.cwd.length > 0
		? objectValue.cwd
		: undefined;
	if (objectValue.cwd !== undefined && explicitCwd === undefined) return undefined;
	const explicitSessionId = objectValue.session_id ?? objectValue.sessionId;
	if (
		(objectValue.session_id !== undefined
			&& (typeof objectValue.session_id !== "string" || objectValue.session_id.length === 0))
		|| (objectValue.sessionId !== undefined
			&& (typeof objectValue.sessionId !== "string" || objectValue.sessionId.length === 0))
		|| (
			typeof objectValue.session_id === "string"
			&& typeof objectValue.sessionId === "string"
			&& objectValue.session_id !== objectValue.sessionId
		)
	) return undefined;
	const sessionId = typeof explicitSessionId === "string" ? explicitSessionId : undefined;
	const manager = objectValue.sessionManager;
	if (manager !== undefined) {
		if (!manager || typeof manager !== "object") return undefined;
		const sessionManager = manager as {
			getCwd?: () => unknown;
			getSessionId?: () => unknown;
		};
		let managerCwd: unknown;
		let managerSessionId: unknown;
		try {
			if (typeof sessionManager.getCwd !== "function" || typeof sessionManager.getSessionId !== "function") return undefined;
			managerCwd = sessionManager.getCwd();
			managerSessionId = sessionManager.getSessionId();
		} catch {
			return undefined;
		}
		if (typeof managerCwd !== "string" || managerCwd.length === 0 || typeof managerSessionId !== "string" || managerSessionId.length === 0) {
			return undefined;
		}
		if (explicitCwd && resolve(explicitCwd) !== resolve(managerCwd)) return undefined;
		if (sessionId && sessionId !== managerSessionId) return undefined;
		return {
			cwd: managerCwd,
			sessionId: managerSessionId,
			managerBacked: true,
		};
	}
	if (!explicitCwd && !sessionId) return {};
	return {
		...(explicitCwd ? { cwd: explicitCwd } : {}),
		...(sessionId ? { sessionId } : {}),
		managerBacked: false,
	};
}

function lifecycleSessionIdentity(event: unknown, ctx: unknown): SessionIdentity | undefined {
	const eventIdentity = sessionIdentityFromValue(event);
	const contextIdentity = sessionIdentityFromValue(ctx);
	if (
		(event && typeof event === "object" && eventIdentity === undefined)
		|| (ctx && typeof ctx === "object" && contextIdentity === undefined)
	) return undefined;
	const cwd = eventIdentity?.cwd ?? contextIdentity?.cwd;
	const sessionId = eventIdentity?.sessionId ?? contextIdentity?.sessionId;
	if (
		!cwd
		|| !sessionId
		|| (eventIdentity?.cwd && resolve(eventIdentity.cwd) !== resolve(cwd))
		|| (contextIdentity?.cwd && resolve(contextIdentity.cwd) !== resolve(cwd))
		|| (eventIdentity?.sessionId && eventIdentity.sessionId !== sessionId)
		|| (contextIdentity?.sessionId && contextIdentity.sessionId !== sessionId)
	) return undefined;
	return {
		cwd,
		sessionId,
		managerBacked: eventIdentity?.managerBacked === true || contextIdentity?.managerBacked === true,
	};
}

function isVerifiedSessionSwitch(
	binding: InternalSessionBinding,
	event: unknown,
	ctx: unknown,
): boolean {
	if (
		!event
		|| typeof event !== "object"
		|| (event as { type?: unknown }).type !== "session_switch"
		|| !["new", "resume", "fork"].includes((event as { reason?: unknown }).reason as string)
	) return false;
	const previousSessionFileValue = (event as { previousSessionFile?: unknown }).previousSessionFile;
	const previousSessionFileSupplied = "previousSessionFile" in event;
	const previousSessionFile = typeof previousSessionFileValue === "string" && previousSessionFileValue.length > 0
		? previousSessionFileValue
		: undefined;
	if (!trustedInteractiveSession(ctx) || !trustedHostActor(event) || !trustedHostActor(ctx)) return false;
	if (!sessionManagerMatchesBinding(binding, ctx)) return false;
	const identity = sessionIdentityFromValue(ctx);
	if (
		!identity
		|| identity.managerBacked !== true
		|| !identity.cwd
		|| !identity.sessionId
		|| !binding.sessionId
		|| identity.sessionId === binding.sessionId
		|| resolve(identity.cwd) !== resolve(binding.cwd)
		|| (ctx as { mode?: unknown }).mode !== binding.mode
	) return false;
	const activeCtoClaim = hasActiveCtoClaim(binding);
	const activeOrdinaryClaim = !activeCtoClaim && (() => {
		try {
			return binding.controller?.activeClaimRunId() !== undefined;
		} catch {
			return true;
		}
	})();
	if (binding.sessionFile !== undefined) {
		if (!previousSessionFile) return false;
		try {
			if (resolve(previousSessionFile) !== resolve(binding.sessionFile)) return false;
		} catch {
			return false;
		}
		return true;
	}
	if (activeCtoClaim || activeOrdinaryClaim || previousSessionFileSupplied) return false;
	return true;
}


function switchSessionBinding(pi: object, event: unknown, ctx: unknown): void {
	const prior = sessionBindings.get(pi);
	if (!prior || !isVerifiedSessionSwitch(prior, event, ctx)) return;
	const cwd = resolveSessionCwd(ctx);
	if (!cwd || resolve(cwd) !== resolve(prior.cwd)) return;
	if (!releaseSessionBinding(pi, "host-session-switched", "session-replacement")) return;
	captureSessionBinding(pi, ctx, cwd);
}

function sessionManagerMatchesBinding(binding: InternalSessionBinding, ctx: unknown): boolean {
	const manager = sessionManagerFromContext(ctx);
	return manager !== undefined && binding.sessionManager !== undefined && manager === binding.sessionManager;
}

function sameBindingIdentity(binding: InternalSessionBinding, identity: SessionIdentity | undefined): boolean {
	return Boolean(
		binding.sessionId
		&& identity?.sessionId
		&& binding.sessionId === identity.sessionId
		&& identity.cwd
		&& resolve(binding.cwd) === resolve(identity.cwd)
	);
}

function capturedManagerIdentity(
	binding: InternalSessionBinding,
	ctx: unknown,
	cwd: string,
): SessionIdentity | undefined {
	const manager = sessionManagerFromContext(ctx);
	const identity = sessionIdentityFromValue(ctx);
	if (
		!identity
		|| identity.managerBacked !== true
		|| !identity.cwd
		|| !identity.sessionId
		|| !manager
		|| (binding.sessionManager !== undefined && manager !== binding.sessionManager)
	) return undefined;
	if (
		resolve(identity.cwd) !== resolve(binding.cwd)
		|| resolve(cwd) !== resolve(binding.cwd)
		|| (binding.sessionId !== undefined && identity.sessionId !== binding.sessionId)
	) return undefined;
	return identity;
}

type CapturedHostSurface = "command" | "raw";

/**
 * Validate only the host-authored profile fields that are meaningful for the
 * ingress surface. Registered commands retain the explicit interactive UI
 * contract; raw tool calls may omit mode/UI only after their exact manager
 * identity is validated by the caller.
 */
function matchesCapturedHostContext(
	binding: InternalSessionBinding,
	ctx: unknown,
	surface: CapturedHostSurface,
): boolean {
	if (!ctx || typeof ctx !== "object" || !trustedHostActor(ctx)) return false;
	const value = ctx as { mode?: unknown; hasUI?: unknown };
	if (value.mode !== undefined && value.mode !== binding.mode) return false;
	if (value.hasUI !== undefined && value.hasUI !== true) return false;
	if (surface === "command") {
		return value.mode === binding.mode && value.hasUI === true;
	}
	return true;
}


function trustedInteractiveLifecycle(
	binding: InternalSessionBinding,
	event: unknown,
	ctx: unknown,
): boolean {
	if (!trustedInteractiveSession(ctx)) return false;
	if (!sessionManagerMatchesBinding(binding, ctx)) return false;
	for (const value of [event, ctx]) {
		if (!value || typeof value !== "object") continue;
		if (!trustedHostActor(value)) return false;
	}
	if (
		event
		&& typeof event === "object"
		&& !Array.isArray(event)
		&& "type" in event
		&& event.type === "session_stop"
		&& "session_file" in event
	) {
		const suppliedSessionFile = event.session_file;
		const managerSessionFile = sessionFileFromManager(sessionManagerFromContext(ctx));
		if (
			typeof suppliedSessionFile !== "string"
			|| suppliedSessionFile.length === 0
			|| !binding.sessionFile
			|| !managerSessionFile
		) return false;
		try {
			if (
				resolve(suppliedSessionFile) !== resolve(binding.sessionFile)
				|| resolve(managerSessionFile) !== resolve(binding.sessionFile)
			) return false;
		} catch {
			return false;
		}
	}
	const mode = (ctx as { mode?: unknown }).mode;
	if (mode !== binding.mode) return false;
	return sameBindingIdentity(binding, lifecycleSessionIdentity(event, ctx));
}

type CtoSuspensionReason = "session-shutdown" | "session-replacement";

function hasActiveCtoClaim(binding: InternalSessionBinding): boolean {
	try {
		return binding.controller?.activeCtoClaim() !== undefined;
	} catch {
		// An unreadable claim is conservative evidence that this binding may
		// still own CTO state. Do not let an idle stop release it.
		return true;
	}
}

function suspendCtoBeforeReset(binding: InternalSessionBinding, reason: CtoSuspensionReason): boolean {
	if (!binding.controller) return true;
	try {
		suspendCtoSession(binding.controller, reason);
		return true;
	} catch {
		console.warn(`[${COMMAND_NAME}]`, JSON.stringify({
			bundle: OMP_INTERNAL_BUNDLE_ID,
			code: "session_cto_suspend_failed",
			reason,
		}));
		return false;
	}
}

function resetControllerForLifecycle(
	binding: InternalSessionBinding,
	receipt: string,
	reason?: CtoSuspensionReason,
): boolean {
	const ctoClaim = hasActiveCtoClaim(binding);
	if (reason && !suspendCtoBeforeReset(binding, reason)) return false;
	// CTO suspension owns release/retention of the CTO claim. Calling the
	// ordinary controller release afterwards could erase a retained pending
	// reservation, so a bound CTO controller is reset only by forgetting this
	// adapter binding.
	if (ctoClaim) return true;
	try {
		binding.controller?.release(receipt);
		return true;
	} catch {
		console.warn(`[${COMMAND_NAME}]`, JSON.stringify({
			bundle: OMP_INTERNAL_BUNDLE_ID,
			code: "session_controller_release_failed",
			receipt,
		}));
		return false;
	}
}

/**
 * Release and forget the current controller before a host-session binding is
 * replaced. A failed release is retained as a conservative busy binding; it
 * is never silently converted into an unowned session.
 */
function releaseSessionBinding(
	pi: object,
	receipt: string,
	reason?: CtoSuspensionReason,
): boolean {
	const prior = sessionBindings.get(pi);
	if (!prior || !resetControllerForLifecycle(prior, receipt, reason)) return !prior;
	sessionBindings.delete(pi);
	return true;
}

/**
 * Release the exact trusted interactive binding while retaining its profile,
 * controller and selected-run view. Core's canonical release semantics clear
 * only the private execution claim and pending command reservation. A resident
 * CTO claim is intentionally not released by an idle turn stop.
 */
function settleSessionBinding(pi: object, event: unknown, ctx: unknown): boolean {
	const binding = sessionBindings.get(pi);
	if (!binding || !trustedInteractiveLifecycle(binding, event, ctx)) return false;
	return resetControllerForLifecycle(binding, "host-session-stop");
}

/**
 * Release and forget only the exact trusted interactive binding. Foreign,
 * worker and headless lifecycle events cannot tear down another host session.
 */
function teardownSessionBinding(
	pi: object,
	event: unknown,
	ctx: unknown,
	receipt: string,
	reason?: CtoSuspensionReason,
): boolean {
	const binding = sessionBindings.get(pi);
	if (!binding || !trustedInteractiveLifecycle(binding, event, ctx)) return false;
	if (!resetControllerForLifecycle(binding, receipt, reason)) return false;
	sessionBindings.delete(pi);
	return true;
}

function buildTrustedController(
	cwd: string,
	sessionId: string,
): WorkflowSessionController | undefined {
	try {
		const context: TrustedExecutionContext = {
			session_id: sessionId,
			caller: "host",
			process_id: process.pid,
			worktree: cwd,
			branch: resolveActiveBranch(cwd),
			authority: "coordinator",
		};
		return createWorkflowSessionController({ cwd, context });
	} catch {
		// Leave the session unbound until a valid trusted context is available.
		return undefined;
	}
}
/**
 * Capture the host session before any lifecycle callback can suspend. A
 * verified replacement suspends a resident CTO before releasing the old
 * ordinary controller and storing the new binding; pending workers remain
 * reserved by core's managed suspension semantics.
 * Same-identity headless starts revoke interactive authority but retain the
 * binding and every claim so a later trusted interactive ingress can restore it.
 */
function captureSessionBinding(pi: object, ctx: unknown, cwd: string): void {
	const interactive = trustedInteractiveSession(ctx);
	const current = sessionBindings.get(pi);
	const value = ctx as { mode?: unknown; hasUI?: unknown };
	const incomingManager = sessionManagerFromContext(ctx);
	const incomingIdentity = sessionIdentityFromValue(ctx);
	if (!trustedHostActor(ctx)) return;
	if (!interactive) {
		if (
			current
			&& current.interactive
			&& sessionManagerMatchesBinding(current, ctx)
			&& incomingIdentity?.managerBacked === true
			&& sameBindingIdentity(current, incomingIdentity)
			&& incomingIdentity.cwd
			&& resolve(incomingIdentity.cwd) === resolve(cwd)
		) {
			// Headless/worker ingress can revoke interactive authority, but it
			// is not a trusted teardown and must not release either ordinary
			// ownership or a resident CTO claim.
			sessionBindings.set(pi, { ...current, interactive: false });
		}
		return;
	}
	const mode = value.mode === "rpc" ? "rpc" : value.mode === "tui" ? "tui" : undefined;
	if (!mode) return;
	if (current) {
		const sameIdentity = sameBindingIdentity(current, incomingIdentity)
			&& incomingIdentity?.cwd
			&& resolve(incomingIdentity.cwd) === resolve(cwd);
		if (sameIdentity && !sessionManagerMatchesBinding(current, ctx)) return;
		if (sameIdentity && current.interactive && current.mode === mode) return;
		if (sameIdentity && !current.interactive) {
			// Re-entry of the exact manager-backed host restores UI authority
			// without replacing the resident controller or its CTO claim.
			sessionBindings.set(pi, { ...current, interactive: true, mode });
			return;
		}
		// A different identity must arrive through the authenticated
		// session_switch path. session_start may only upgrade a managerless
		// placeholder that never held a controller or ownership.
		if (current.sessionId !== undefined || current.sessionManager !== undefined || current.controller !== undefined) return;
		if (
			incomingIdentity?.managerBacked !== true
			|| !incomingIdentity.sessionId
			|| !incomingIdentity.cwd
			|| (current.sessionManager !== undefined && incomingManager !== current.sessionManager)
		) return;
		if (!releaseSessionBinding(pi, "host-session-replaced", "session-replacement")) return;
	}
	const sessionId = incomingIdentity?.managerBacked === true ? incomingIdentity.sessionId : undefined;
	const controller = sessionId ? buildTrustedController(cwd, sessionId) : undefined;
	sessionBindings.set(pi, {
		cwd,
		interactive,
		mode,
		...(sessionId ? { sessionId } : {}),
		...(incomingManager ? { sessionManager: incomingManager, sessionFile: sessionFileFromManager(incomingManager) } : {}),
		...(controller ? { controller } : {}),
	});
}


/**
 * Return the captured controller only for its originating workspace/session.
 * Never infer a run from cwd, selection, or a later callback. If the trusted
 * host session initially omitted its ID, bind lazily from a later ingress
 * context that exposes the host session manager's ID.
 */
function sharedSessionController(pi: object, ctx: unknown, cwd: string): WorkflowSessionController | undefined {
	const binding = sessionBindings.get(pi);
	if (!binding || resolve(binding.cwd) !== resolve(cwd) || !binding.interactive) return undefined;
	if (!matchesCapturedHostContext(binding, ctx, "command")) return undefined;
	const identity = capturedManagerIdentity(binding, ctx, cwd);
	if (!identity) return undefined;
	const sessionId = identity.sessionId;
	if (!sessionId) return undefined;
	const manager = sessionManagerFromContext(ctx);
	if (!manager) return undefined;
	// A manager can expose its file after the lifecycle binding was first captured.
	// CTO ingress refuses to acquire without it; retain that official association
	// now so a later verified session_switch can still release the admitted claim.
	if (binding.sessionFile === undefined) binding.sessionFile = sessionFileFromManager(manager);
	if (binding.controller) return binding.controller;
	const controller = buildTrustedController(cwd, sessionId);
	if (!controller) return undefined;
	binding.sessionId = sessionId;
	binding.sessionManager = manager;
	binding.controller = controller;
	return controller;
}

/**
 * Resolve the narrow orchestrator capability for raw tool calls from the
 * already-captured host binding. The manager identity is re-read on every
 * call; a raw context can neither create nor replace this controller.
 */
function resolveInternalTrustedToolCallActor(
	pi: object,
	ctx: unknown,
	cwd: string,
	runId: string | undefined,
): TrustedToolCallResolution | undefined {
	const binding = sessionBindings.get(pi);
	if (!binding?.interactive || !binding.sessionId || !binding.controller) return undefined;
	if (!matchesCapturedHostContext(binding, ctx, "raw")) return undefined;
	const identity = capturedManagerIdentity(binding, ctx, cwd);
	if (!identity || identity.sessionId !== binding.sessionId) return undefined;
	try {
		const controllerContext = binding.controller.context();
		if (
			controllerContext.session_id !== binding.sessionId
			|| resolve(controllerContext.worktree) !== resolve(binding.cwd)
		) return undefined;

		// CTO authority is the controller's exact current claim proof. It is
		// intentionally resolved before ordinary selection/claim checks: a CTO
		// run is not authorized by selectedRunId, owner_session, runTarget, or
		// an ordinary run UUID.
		const ctoClaim = binding.controller.activeCtoClaim();
		if (ctoClaim !== undefined) {
			if (
				typeof ctoClaim.run_id !== "string"
				|| ctoClaim.run_id.length === 0
				|| typeof ctoClaim.ownership_epoch !== "string"
				|| ctoClaim.ownership_epoch.length === 0
			) return undefined;
			return {
				kind: "authenticated-interactive-host-cto",
				run_id: ctoClaim.run_id,
				ownership_epoch: ctoClaim.ownership_epoch,
			};
		}

		const selectedRunId = binding.controller.selectedRunId();
		const activeClaimRunId = binding.controller.activeClaimRunId();
		if (selectedRunId !== runId || activeClaimRunId !== runId) return undefined;
		if (runId === undefined) return { kind: "authenticated-interactive-host-no-run" };
		const artifactsDir = runTarget(binding.cwd, runId).artifactsDir;
		const expectedArtifactsDir = resolve(binding.cwd, ".work-state", "runs", runId, "artifacts");
		return resolve(artifactsDir) === expectedArtifactsDir
			? { actor: "orchestrator", artifactsDir }
			: undefined;
	} catch {
		return undefined;
	}
}
function rawSessionController(pi: object, ctx: unknown, cwd: string): WorkflowSessionController | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const binding = sessionBindings.get(pi);
	if (!binding?.interactive || !binding.controller) return undefined;
	if (!matchesCapturedHostContext(binding, ctx, "raw")) return undefined;
	const identity = capturedManagerIdentity(binding, ctx, cwd);
	if (!identity || identity.sessionId !== binding.sessionId) return undefined;
	try {
		const controllerContext = binding.controller.context();
		return controllerContext.session_id === binding.sessionId
			&& resolve(controllerContext.worktree) === resolve(binding.cwd)
			? binding.controller
			: undefined;
	} catch {
		return undefined;
	}
}

/** Entry points already wired for a given pi instance (idempotent per host). */
const activatedEngines = new WeakSet<object>();

/**
 * Resolve the session project root for hooks, tools and the command handler.
 *
 * Core seam pattern: the session manager is authoritative; `ctx.cwd` is the
 * fallback; the process cwd is never substituted. A missing cwd stays
 * unavailable so callers fail closed instead of guessing.
 */
export function resolveSessionCwd(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const objectContext = ctx as { cwd?: unknown; sessionManager?: unknown };
	const manager = objectContext.sessionManager;
	if (manager && typeof manager === "object") {
		try {
			if ("getCwd" in manager && typeof manager.getCwd === "function") {
				const sessionManager = manager as { getCwd: () => unknown };
				const sessionCwd = sessionManager.getCwd();
				if (typeof sessionCwd === "string" && sessionCwd.length > 0) return sessionCwd;
			}
		} catch {
			// Fall through to the context cwd.
		}
	}
	return typeof objectContext.cwd === "string" && objectContext.cwd.length > 0 ? objectContext.cwd : undefined;
}

/**
 * Session-cwd resolver for the namespaced command surface.
 *
 * Returns the session cwd ONLY when `detectWorkspaceMarkers(cwd).ok` holds:
 * an unmarked or unavailable session root resolves to `undefined`. Core's
 * command seam consults this resolver first and then fails closed through
 * the gated owner source (`privateOmpOwnerForMarkedWorkspace`), so the
 * namespaced descriptors can publish eagerly for slash-discovery while a
 * session outside the marked workspace still ends up with zero claims and
 * no workflow dispatch.
 */
export function resolveGatedCommandCwd(ctx: unknown): string | undefined {
	const cwd = resolveSessionCwd(ctx);
	if (!cwd) return undefined;
	return detectWorkspaceMarkers(cwd).ok ? cwd : undefined;
}

export type ActivationOutcome =
	| { ok: true }
	| { ok: false; code: "activation_markers_missing"; missing: string[] }
	| { ok: false; code: "owner_conflict" | "owner_invalid" | "profile_invalid"; error: string }
	| { ok: false; code: "registration_failed"; error: string };

/**
 * Run the activation gate and wire core seams on success.
 *
 * Fail-closed ordering:
 *  1. markers must all be present;
 *  2. bundle profiles must load and validate;
 *  3. the atomic multi-capability owner claim must succeed — any conflict
 *     aborts before the registry mutates and before ANY engine registration;
 *  4. the runtime config is seeded write-if-absent — synchronously, BEFORE
 *     the idempotence short-circuit and before any discovery refresh can
 *     resolve roles, so a clean marked workspace carries the default omp-*
 *     role config on its very first session (never overwrites a custom one);
 *  5. engine registration and adapter wiring.
 */
export function ensureEngineActivation(pi: ExtensionAPI, cwd: string): ActivationOutcome {
	const gate = detectWorkspaceMarkers(cwd);
	if (!gate.ok) {
		return { ok: false, code: gate.code, missing: gate.missing.map((marker) => marker.path) };
	}

	let profiles;
	try {
		profiles = loadOmpWorkflowProfiles();
	} catch (error) {
		return { ok: false, code: "profile_invalid", error: String(error instanceof Error ? error.message : error) };
	}

	const claim = claimWorkflowOwners(cwd, ALL_CAPABILITIES, privateOmpOwnerForCwd(cwd));
	if (!claim.ok) {
		return { ok: false, code: claim.code, error: claim.error };
	}

	// Registration presets shared verbatim by engine wiring and the config
	// seed: core's writeRuntimeConfig writes exactly these values when the
	const registrationOpts: RegisterOptions = {
		label: OMP_INTERNAL_BUNDLE_ID,
		roles: defaultOmpInternalRoles,
		scopeMap: defaultOmpInternalScopeMap,
		scopeRuntimeClasses: defaultOmpInternalScopeRuntimeClasses,
		scopeUiClasses: defaultOmpInternalScopeUiClasses,
		flags: defaultOmpInternalFlags,
		workflowProfiles: profiles,
		resolveCwd: resolveSessionCwd,
		owner: privateOmpOwnerForCwd,
		resolveTrustedToolCallActor: (ctx, sessionCwd, runId) =>
			resolveInternalTrustedToolCallActor(pi, ctx, sessionCwd, runId),
		getSessionController: (ctx, sessionCwd) => rawSessionController(pi, ctx, sessionCwd),
	};

	// Seed-if-absent BEFORE the short-circuit and before ANY discovery
	// refresh resolves roles: core registers its config-writer as a
	// session_start callback, which cannot seed the CURRENT event, so a
	// clean marked workspace (no .omp/team.config.json) previously reached
	// the live roster refresh with empty config roles — required profile
	// roles mapped to unprefixed names and the first session failed closed
	// until a second session_start. Synchronous here means the seed always
	// precedes the refresh kickoff and the first begin's beforeBegin.
	try {
		writeRuntimeConfig(registrationOpts, cwd);
	} catch (error) {
		return {
			ok: false,
			code: "registration_failed",
			error: String(error instanceof Error ? error.message : error),
		};
	}

	if (activatedEngines.has(pi)) return { ok: true };

	// Registration is the last step and the WeakSet mark lands only AFTER it
	// succeeds (SEC-BUNDLE-001): a throw mid-registration must not leave the
	// host silently marked as wired while zero tools/gates are registered.
	try {
		registerTeamWorkflow(pi, registrationOpts);
		const adapter: WorkflowToolAdapter = createWorkflowToolAdapter({
			owner: privateOmpOwnerForCwd,
			getSessionController: (ctx, sessionCwd) => sharedSessionController(pi, ctx, sessionCwd),
			// Hand the fresh, provenance-checked mapping to core so workflow_begin
			// authorizes from this session's discovery — in memory, never from the
			// persisted mapping file. A failed refresh rejects here, which blocks
			// the begin (fail closed) instead of letting a stale roster stand in.
			beforeBegin: (sessionCwd) => waitForInternalAgentMappings(sessionCwd),
		});
		adapter.register(pi);
	} catch (error) {
		activatedEngines.delete(pi);
		return {
			ok: false,
			code: "registration_failed",
			error: String(error instanceof Error ? error.message : error),
		};
	}
	activatedEngines.add(pi);
	return { ok: true };
}

function formatDiagnostic(outcome: Exclude<ActivationOutcome, { ok: true }>): string {
	switch (outcome.code) {
		case "activation_markers_missing":
			return [
				`[omp-workflow-team] activation failed: ${OMP_INTERNAL_ACTIVATION_MARKER}`,
				"code: activation_markers_missing",
				"missing markers:",
				...outcome.missing.map((path) => `  - ${path}`),
				"Engine registration skipped (fail closed).",
			].join("\n");
		case "profile_invalid":
			return [
				`[omp-workflow-team] activation failed: ${OMP_INTERNAL_ACTIVATION_MARKER}`,
				`code: profile_invalid`,
				`error: ${outcome.error}`,
				"Engine registration skipped (fail closed).",
			].join("\n");
		default:
			return [
				`[omp-workflow-team] activation failed: ${OMP_INTERNAL_ACTIVATION_MARKER}`,
				`code: ${outcome.code}`,
				`error: ${outcome.error}`,
				"Engine registration skipped (fail closed).",
			].join("\n");
	}
}

/**
 * READ-ONLY validation report: marker check result, current owner claims for
 * all three capability families via `workflowOwnerFor`, agent pool listing.
 * Performs no claims and no registration.
 */
function buildValidateReport(cwd: string): string {
	const lines: string[] = [`[omp-workflow-team] validate (read-only) — root: ${cwd}`];
	const gate = detectWorkspaceMarkers(cwd);
	if (gate.ok) {
		lines.push("markers: OK");
		for (const marker of gate.markers) lines.push(`  - ${marker.name} (${marker.kind})`);
	} else {
		lines.push(`markers: MISSING (code=${gate.code})`);
		for (const marker of gate.missing) lines.push(`  - ${marker.name} (${marker.kind}) at ${marker.path}`);
	}
	lines.push("owners:");
	for (const capability of ALL_CAPABILITIES) {
		const claim = workflowOwnerFor(cwd, capability);
		lines.push(
			claim
				? `  - ${capability}: ${claim.owner.owner_id} (${claim.owner.owner_kind})`
				: `  - ${capability}: unclaimed`,
		);
	}
	lines.push("identity:");
	lines.push(`  - bundle_id: ${OMP_INTERNAL_BUNDLE_ID}`);
	lines.push(`  - owner_kind: ${OMP_INTERNAL_OWNER_KIND}`);
	lines.push(`  - activation_marker: ${OMP_INTERNAL_ACTIVATION_MARKER}`);
	lines.push(`allowed pool (${ALLOWED_POOL_AGENTS.length}):`);
	for (const agent of ALLOWED_POOL_AGENTS) lines.push(`  - ${agent}`);
	return lines.join("\n");
}


export default function ompWorkflowsInternal(pi: ExtensionAPI): void {
	// Diagnostic/command surface — registered unconditionally. This is NOT
	// workflow-engine registration: it performs zero claims, zero tool
	// registrations and zero config writes, and is the only channel through
	// which a fail-closed host can learn why nothing activated.
	pi.registerCommand(COMMAND_NAME, {
		description: `Private OMP workflow team (${OMP_INTERNAL_ACTIVATION_MARKER}). '/omp-workflow-team validate' is read-only.`,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const cwd = resolveSessionCwd(ctx);
			if (!cwd) {
				pi.sendUserMessage("[omp-workflow-team] ERROR: workflow cwd unavailable.");
				return;
			}
			if (trimmed === "validate") {
				pi.sendUserMessage(buildValidateReport(cwd));
				return;
			}
			const outcome = ensureEngineActivation(pi, cwd);
			if (!outcome.ok) {
				pi.sendUserMessage(formatDiagnostic(outcome));
				return;
			}
			const command = parseWorkflowCommand(trimmed);
			if (!command.ok) {
				pi.sendUserMessage(`ERROR [${command.code}]: ${command.error}`);
				return;
			}
			if (command.mode === "list") {
				// Listing is a canonical read snapshot, not a fresh catalog
				// sort. The snapshot ID/index pair is the selector binding that
				// workflow_prepare must later revalidate under lock.
				const sharedController = command.all_branches ? undefined : sharedSessionController(pi, ctx, cwd);
				const selector = sharedController?.readSelector() ?? createWorkflowReadSelector(
					cwd,
					command.all_branches ? {} : { branch: resolveActiveBranch(cwd) },
				);
				const snapshot = selector.list({ includeTerminal: true });
				pi.sendUserMessage(
					snapshot.candidates.length === 0
						? "No workflow runs found."
						: snapshot.candidates
								.map(
									(candidate, index) =>
										`${index + 1}. ${candidate.title} — ${candidate.branch} — ${candidate.status} — ${candidate.stage} (snapshot_id=${snapshot.snapshot_id}; index=${index}; run_id=${candidate.run_id})`,
								)
								.join("\n"),
				);
				return;
			}
			const parsed = parseWorkEnvelope(command.task, cwd);
			if (!parsed.task && !command.mode) {
				pi.sendUserMessage(
					"[omp-workflow-team] Usage: /omp-workflow-team <task description> (or `/omp-workflow-team validate`).",
				);
				return;
			}
			const envelope = {
				...parsed,
				...(command.mode ? { mode: command.mode } : {}),
				...(command.run_id ? { run_id: command.run_id } : {}),
			};
			pi.sendUserMessage(buildDoWorkPrompt(envelope, cwd));
		},
	});
	// OMP18.2.2 emits session_switch after /new and /resume mutate the same
	// live SessionManager. Register the bundle transition before core's lazy
	// lifecycle handlers so the old controller is suspended and the new
	// same-manager binding is available when core resolves its incoming
	// controller; a missing/foreign previous file leaves the old claim intact.
	pi.on("session_switch", (event: unknown, ctx: unknown) => {
		switchSessionBinding(pi, event, ctx);
	});
	// Namespaced core registration surface: `/omp-do-work`, `/omp-team`,
	// `/omp-cto`. Descriptors publish eagerly during extension load so OMP's
	// slash-suggestion snapshot sees them; marker gating remains in the cwd
	// resolver and owner source, so unmarked sessions claim nothing.
	registerWorkflowCommands(pi, {
		namespace: COMMAND_NAMESPACE,
		...NAMESPACED_DESCRIPTIONS,
		owner: privateOmpOwnerForMarkedWorkspace,
		resolveCwd: resolveGatedCommandCwd,
		getSessionController: (ctx, cwd) => sharedSessionController(pi, ctx, cwd),
	});

	pi.on("session_start", (event: unknown, ctx: unknown) => {
		const cwd = resolveSessionCwd(ctx);
		if (!cwd || !detectWorkspaceMarkers(cwd).ok) {
			// Only the exact trusted interactive lifecycle identity can end
			// the host binding; foreign and headless starts preserve it.
			if (trustedInteractiveSession(ctx)) {
				teardownSessionBinding(pi, event, ctx, "host-session-unavailable", "session-replacement");
			}
			return;
		}
		// Capture trusted host/session identity before kicking off any async
		// discovery. Later tool callbacks use this closure, never a new run
		// selected while discovery is suspended.
		captureSessionBinding(pi, ctx, cwd);
		// Activation FIRST: on a clean marked workspace it synchronously seeds
		// the default omp-* role config (write-if-absent), so the refresh
		// kicked below resolves real roles on the very first session instead
		// of failing closed on empty config until a second session_start.
		const outcome = ensureEngineActivation(pi, cwd);
		if (!outcome.ok) {
			// SEC-BUNDLE-003: no absolute paths in host logs — marker names and
			// typed codes only.
			const detail =
				outcome.code === "activation_markers_missing"
					? { code: outcome.code, missing: outcome.missing.map((path) => path.slice(cwd.length + 1)) }
					: { code: outcome.code, error: outcome.error };
			console.warn(`[${COMMAND_NAME}]`, JSON.stringify({ bundle: OMP_INTERNAL_BUNDLE_ID, ...detail }));
		}
		// Bundle-owned live roster refresh: lazily discovers the host agents and
		// republishes the exact omp-* role mapping. Marker-gated (fails closed
		// outside the marked workspace), deduped per root, joined by the
		// workflow tool adapter in beforeBegin, and kicked only AFTER
		// activation + config seed so discovery never races an unseeded
		// resolveConfig. Fire and forget — a rejected refresh fails closed
		// without blocking activation.
		if (detectWorkspaceMarkers(cwd).ok) {
			void refreshInternalAgentMappings(cwd).catch((error: unknown) => {
				// SEC-BUNDLE-003: no absolute paths in host logs — typed code plus
				// the typed error text (agent names) only.
				console.warn(`[${COMMAND_NAME}]`, JSON.stringify({
					bundle: OMP_INTERNAL_BUNDLE_ID,
					code: "agent_mapping_refresh_failed",
					error: String(error instanceof Error ? error.message : error),
				}));
			});
		}
	});
	pi.on("session_stop", (event: unknown, ctx: unknown) => {
		settleSessionBinding(pi, event, ctx);
	});
	pi.on("session_shutdown", (event: unknown, ctx: unknown) => {
		teardownSessionBinding(pi, event, ctx, "host-session-shutdown", "session-shutdown");
	});
}
