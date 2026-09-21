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
		"CTO sub-orchestration (main-session role): the resident CTO decomposes a task into parallel development teams. /omp-cto <task>; /omp-cto alone starts STANDBY (tasks arrive via messenger inbox). Runs in-session — never task(agent=cto)",
} as const;

interface InternalSessionBinding {
	cwd: string;
	interactive: boolean;
	mode: "tui" | "rpc";
	sessionId?: string;
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

function trustedInteractiveSession(ctx: unknown): boolean {
	if (!ctx || typeof ctx !== "object") return false;
	const host = ctx as { mode?: unknown; hasUI?: unknown };
	return host.hasUI === true && (host.mode === "tui" || host.mode === "rpc");
}

/**
 * Release and forget the current controller before a host-session binding is
 * replaced or stopped. A failed release is retained as a conservative busy
 * binding; it is never silently converted into an unowned session.
 */
function releaseSessionBinding(pi: object, receipt: string): boolean {
	const prior = sessionBindings.get(pi);
	try {
		prior?.controller?.release(receipt);
		sessionBindings.delete(pi);
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
 * replacement releases the old coordinator before the new binding is stored;
 * pending workers remain reserved by core's release semantics. Hosts that do
 * not expose a session ID remain unbound until a later trusted ingress
 * supplies one.
 */
function captureSessionBinding(pi: object, ctx: unknown, cwd: string): void {
	const interactive = trustedInteractiveSession(ctx);
	const current = sessionBindings.get(pi);
	const incomingSession = sessionIdFromContext(ctx);
	const value = ctx as { mode?: unknown; hasUI?: unknown };
	if (!interactive) {
		// A same-session headless lifecycle boundary invalidates interactive
		// authority but conservatively retains the controller/claim for later
		// reconciliation. Foreign noninteractive events cannot mutate it.
		if (
			current
			&& current.sessionId
			&& incomingSession === current.sessionId
			&& current.cwd === cwd
		) {
			sessionBindings.set(pi, { ...current, interactive: false });
		}
		return;
	}
	if (!releaseSessionBinding(pi, "host-session-replaced")) return;

	const mode = value.mode === "rpc" ? "rpc" : value.mode === "tui" ? "tui" : undefined;
	if (!mode) return;
	const sessionId = incomingSession;
	const controller = sessionId ? buildTrustedController(cwd, sessionId) : undefined;
	sessionBindings.set(pi, {
		cwd,
		interactive,
		mode,
		...(sessionId ? { sessionId } : {}),
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
	if (!binding || binding.cwd !== cwd || !binding.interactive) return undefined;
	if (ctx && typeof ctx === "object") {
		// Host tool contexts carry actor as a trusted in-process discriminator.
		const hostContext = ctx as { actor?: unknown };
		const actor = hostContext.actor;
		if (actor === "worker" || actor === "lead") return undefined;
	}
	const requestedSession = sessionIdFromContext(ctx);
	if (requestedSession && binding.sessionId && requestedSession !== binding.sessionId) return undefined;
	if (binding.controller) return binding.controller;
	if (!requestedSession) return undefined;
	const controller = buildTrustedController(cwd, requestedSession);
	if (!controller) return undefined;
	binding.sessionId = requestedSession;
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
	if (!runId || !ctx || typeof ctx !== "object") return undefined;
	const binding = sessionBindings.get(pi);
	if (!binding?.interactive || !binding.sessionId || !binding.controller) return undefined;
	const value = ctx as {
		mode?: unknown;
		hasUI?: unknown;
		sessionManager?: { getCwd?: () => unknown; getSessionId?: () => unknown };
	};
	const manager = value.sessionManager;
	if (!manager || typeof manager.getCwd !== "function" || typeof manager.getSessionId !== "function") return undefined;
	let managerCwd: unknown;
	let managerSessionId: unknown;
	try {
		managerCwd = manager.getCwd();
		managerSessionId = manager.getSessionId();
	} catch {
		return undefined;
	}
	if (
		typeof managerCwd !== "string"
		|| typeof managerSessionId !== "string"
		|| managerSessionId !== binding.sessionId
		|| resolve(managerCwd) !== resolve(binding.cwd)
		|| resolve(cwd) !== resolve(binding.cwd)
	) return undefined;
	if (value.mode !== undefined && value.mode !== binding.mode) return undefined;
	if (value.hasUI !== undefined && (binding.mode === "rpc" ? value.hasUI !== false : value.hasUI !== true)) return undefined;
	try {
		const controllerContext = binding.controller.context();
		if (
			controllerContext.session_id !== binding.sessionId
			|| resolve(controllerContext.worktree) !== resolve(binding.cwd)
			|| binding.controller.selectedRunId() !== runId
		) return undefined;
		const artifactsDir = runTarget(binding.cwd, runId).artifactsDir;
		const expectedArtifactsDir = resolve(binding.cwd, ".work-state", "runs", runId, "artifacts");
		return resolve(artifactsDir) === expectedArtifactsDir
			? { actor: "orchestrator", artifactsDir }
			: undefined;
	} catch {
		return undefined;
	}
}

/** Raw tool-call ingress may only read the captured binding; it never lazily
 * creates or replaces a controller from a callback context. */
function rawSessionController(pi: object, ctx: unknown, cwd: string): WorkflowSessionController | undefined {
	const binding = sessionBindings.get(pi);
	if (!binding?.interactive || !binding.controller || !ctx || typeof ctx !== "object") return undefined;
	const manager = (ctx as {
		sessionManager?: { getCwd?: () => unknown; getSessionId?: () => unknown };
	}).sessionManager;
	if (!manager || typeof manager.getCwd !== "function" || typeof manager.getSessionId !== "function") return undefined;
	try {
		const managerCwd = manager.getCwd();
		const managerSessionId = manager.getSessionId();
		if (
			typeof managerCwd !== "string"
			|| typeof managerSessionId !== "string"
			|| managerSessionId !== binding.sessionId
			|| resolve(managerCwd) !== resolve(binding.cwd)
			|| resolve(cwd) !== resolve(binding.cwd)
		) return undefined;
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
	if (manager && typeof manager === "object" && "getCwd" in manager && typeof manager.getCwd === "function") {
		try {
			// Structurally verified by the `in` + typeof check above; TS cannot
			// narrow `unknown` to a callable member on its own.
			const sessionManager = manager as { getCwd: () => unknown };
			const sessionCwd = sessionManager.getCwd();
			if (typeof sessionCwd === "string" && sessionCwd.length > 0) return sessionCwd;
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

	pi.on("session_start", (_event: unknown, ctx: unknown) => {
		const cwd = resolveSessionCwd(ctx);
		if (!cwd || !detectWorkspaceMarkers(cwd).ok) {
			// Only a trusted interactive lifecycle event can end the host binding
			// here; untrusted/noninteractive events preserve it even without cwd.
			if (trustedInteractiveSession(ctx)) {
				releaseSessionBinding(pi, "host-session-unavailable");
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
	pi.on("session_stop", () => {
		releaseSessionBinding(pi, "host-session-stop");
	});
}
