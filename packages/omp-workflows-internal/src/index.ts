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
 * `omp-cto`. The namespaced descriptors mount lazily during a marked session_start
 * for slash-discovery, and remain marker-gated: outside a marked
 * internal workspace the resolver yields no cwd and the gated owner source
 * refuses to claim, so session_start and handlers register ZERO owners.
 * Bare `do-work` / `team` / `cto` names are never registered (they belong
 * to the external fullstack plugin) and `omp-model-roles` is never shadowed.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	buildDoWorkPrompt,
	PinnedProjectRoot,
	createWorkflowToolAdapter,
	parseWorkEnvelope,
	registerTeamWorkflow,
	registerWorkflowCommands,
	writeRuntimeConfig,
	type WorkflowOwnerSource,
	type WorkflowToolAdapter,
} from "@andvl1/omp-workflows-core";
import {
	beginRegistryRegistration,
	closeWorkflowActivation,
	openWorkflowActivation,
	rollbackRegistryRegistration,
	commitRegistryRegistration,
	type WorkflowActivationResult,
	type WorkflowCapability,
	type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core/registry";

import {
	captureWorkspaceActivation,
	detectWorkspaceMarkers,
	validateWorkspaceActivation,
	type WorkspaceActivationSnapshot,
} from "./activation.js";
import {
	OMP_INTERNAL_ACTIVATION_MARKER,
	OMP_INTERNAL_BUNDLE_ID,
	OMP_INTERNAL_OWNER_KIND,
	privateOmpOwnerForPinnedRoot,
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

/** Entry points already wired for a given pi instance (idempotent per host). */
const activatedEngines = new WeakSet<object>();
type InternalGateInstallation = {
	readonly key: string;
	readonly activation: Extract<WorkflowActivationResult, { ok: true }>;
};
const internalGateInstallations = new Map<string, Set<InternalGateInstallation>>();

interface PinnedActivation {
	snapshot: WorkspaceActivationSnapshot;
	revoked: boolean;
	/** The one activation lease retained for this host instance. */
	retainedLease?: Extract<WorkflowActivationResult, { ok: true }>;
	/** One retained closure shared by registration and adapter ownership calls. */
	owner: (cwd: string) => WorkflowOwnerIdentity;
	/** The gate lease installed by this activation, if any. */
	gateInstallation?: InternalGateInstallation;
	/** Host session generation, when the lifecycle event exposed one. */
	sessionId?: string;
}

const pinnedActivations = new WeakMap<object, PinnedActivation>();
const internalShutdownHandlers = new WeakSet<object>();

type ActivationResolution =
	| { ok: true; activation: PinnedActivation }
	| { ok: false; code: "activation_markers_missing" | "activation_identity_changed"; missing: string[]; error: string };

function missingMarkerPaths(cwd: string): string[] {
	const gate = detectWorkspaceMarkers(cwd);
	return gate.ok ? [] : gate.missing.map(marker => marker.path);
}

function revokePinnedActivation(activation: PinnedActivation): void {
	const installation = activation.gateInstallation;
	if (installation) {
		const installations = internalGateInstallations.get(installation.key);
		if (installations?.has(installation)) {
			installations.delete(installation);
			if (installations.size === 0 && internalGateInstallations.get(installation.key) === installations) internalGateInstallations.delete(installation.key);
		}
		activation.gateInstallation = undefined;
	}
	if (activation.retainedLease) {
		closeWorkflowActivation(activation.retainedLease);
		activation.retainedLease = undefined;
	}
	activation.revoked = true;
}

/** Resolve and retain one root-pinned policy per host extension instance. */
function resolvePinnedActivation(pi: ExtensionAPI, cwd: string, sessionId?: string): ActivationResolution {
	const prior = pinnedActivations.get(pi as object);
	if (prior) {
		if (prior.revoked) {
			revokePinnedActivation(prior);
			return {
				ok: false,
				code: "activation_identity_changed",
				missing: [],
				error: "activation identity was revoked",
			};
		}
		const checked = validateWorkspaceActivation(prior.snapshot, cwd);
		if (!checked.ok) {
			revokePinnedActivation(prior);
			return {
				ok: false,
				code: checked.code,
				missing: checked.code === "activation_markers_missing" ? missingMarkerPaths(cwd) : [],
				error: checked.code === "activation_markers_missing"
					? "accepted workspace markers are unavailable"
					: "accepted workspace root or marker identity changed",
			};
		}
		return { ok: true, activation: prior };
	}

	const captured = captureWorkspaceActivation(cwd);
	if (!captured.ok) {
		return {
			ok: false,
			code: captured.code,
			missing: captured.code === "activation_markers_missing" ? missingMarkerPaths(cwd) : [],
			error: captured.code === "activation_markers_missing"
				? "workspace markers are unavailable"
				: "workspace root or marker identity could not be pinned",
		};
	}

	const activation: PinnedActivation = {
		snapshot: captured.snapshot,
		revoked: false,
		...(sessionId ? { sessionId } : {}),
		owner: undefined as unknown as (cwd: string) => WorkflowOwnerIdentity,
	};
	activation.owner = (candidateCwd: string): WorkflowOwnerIdentity => {
		if (activation.revoked) throw new Error("activation_identity_changed: activation identity was revoked");
		const checked = validateWorkspaceActivation(activation.snapshot, candidateCwd);
		if (!checked.ok) {
			revokePinnedActivation(activation);
			throw new Error(`${checked.code}: accepted workspace root or marker identity changed`);
		}
		return privateOmpOwnerForPinnedRoot(activation.snapshot.canonicalRoot);
	};
	pinnedActivations.set(pi as object, activation);
	return { ok: true, activation };
}

/** Owner source used by lazily mounted commands before engine wiring. */
function pinnedOwnerSourceFor(pi: ExtensionAPI): WorkflowOwnerSource {
	return (cwd: string): WorkflowOwnerIdentity => {
		const resolved = resolvePinnedActivation(pi, cwd);
		if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.error}`);
		return resolved.activation.owner(cwd);
	};
}

/**
 * Resolve the session project root for hooks, tools and the command handler.
 *
 * Core seam pattern: a supplied session manager is authoritative; `ctx.cwd`
 * is used only when the manager is absent. The process cwd is never
 * substituted. A missing or unsafe cwd stays unavailable so callers fail
 * closed instead of guessing.
 */
export function resolveSessionCwd(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const objectContext = ctx as { cwd?: unknown; sessionManager?: unknown };
	const manager = objectContext.sessionManager;
	if (manager !== undefined && manager !== null) {
		// A supplied manager is authoritative. Missing, malformed, unsafe or
		// throwing getCwd must not revive a stale copied ctx.cwd fallback.
		if (typeof manager !== "object" || !("getCwd" in manager)) return undefined;
		try {
			// Read the method itself inside the guard too: a hostile proxy/getter
			// must fail closed just like a method that throws when invoked.
			const getCwd = (manager as { getCwd?: unknown }).getCwd;
			if (typeof getCwd !== "function") return undefined;
			const sessionCwd = getCwd.call(manager);
			return typeof sessionCwd === "string" && sessionCwd.length > 0 ? sessionCwd : undefined;
		} catch {
			return undefined;
		}
	}
	return typeof objectContext.cwd === "string" && objectContext.cwd.length > 0 ? objectContext.cwd : undefined;
}

/** Extract one bounded lifecycle generation id; event data outranks mutable context state. */
function sessionIdentityFromContext(event: unknown, ctx: unknown): string | undefined {
	for (const source of [event, ctx]) {
		if (!source || typeof source !== "object") continue;
		try {
			let identityFieldPresent = false;
			for (const key of ["sessionId", "session_id"] as const) {
				if (!(key in (source as object))) continue;
				identityFieldPresent = true;
				const value = (source as Record<string, unknown>)[key];
				if (typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)) return value;
			}
			// An explicitly present but malformed identity is authoritative and
			// must not fall through to mutable context state.
			if (identityFieldPresent) return undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const manager = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>).sessionManager : undefined;
		if (manager && typeof manager === "object") {
			const getter = (manager as Record<string, unknown>).getSessionId;
			if (typeof getter !== "function") return undefined;
			const value = getter.call(manager);
			return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * Session-cwd resolver for the namespaced command surface.
 *
 * Returns the session cwd ONLY when `detectWorkspaceMarkers(cwd).ok` holds:
 * an unmarked or unavailable session root resolves to `undefined`. Core's
 * command seam consults this resolver first and then fails closed through
 * the pinned owner source, so the namespaced descriptors can publish eagerly
 * for slash-discovery while a session outside the marked workspace still
 * ends up with zero claims and no workflow dispatch.
 */
export function resolveGatedCommandCwd(ctx: unknown): string | undefined {
	const cwd = resolveSessionCwd(ctx);
	if (!cwd) return undefined;
	return detectWorkspaceMarkers(cwd).ok ? cwd : undefined;
}

function openActivationRoot(snapshot: WorkspaceActivationSnapshot): PinnedProjectRoot | undefined {
	const pinned = PinnedProjectRoot.open(snapshot.canonicalRoot);
	if (!pinned) return undefined;
	if (pinned.canonical_root !== snapshot.canonicalRoot
		|| pinned.dev !== snapshot.rootDev
		|| pinned.ino !== snapshot.rootIno
		|| !pinned.isStable()) {
		pinned.close();
		return undefined;
	}
	return pinned;
}

export type ActivationOutcome =
	| { ok: true }
	| { ok: false; code: "activation_markers_missing"; missing: string[] }
	| { ok: false; code: "activation_identity_changed"; error: string }
	| { ok: false; code: "owner_conflict" | "owner_invalid" | "profile_invalid"; error: string }
	| { ok: false; code: "registration_failed"; error: string };

/**
 * Run the activation gate and wire core seams on success.
 *
 * Fail-closed ordering:
 *  1. markers and the pinned root identity must be valid;
 *  2. bundle profiles must load and validate;
 *  3. the atomic multi-capability owner claim must succeed — any conflict
 *     aborts before the registry mutates and before ANY engine registration;
 *  4. the runtime config is seeded write-if-absent — synchronously, BEFORE
 *     the idempotence short-circuit and before any discovery refresh can
 *     resolve roles;
 *  5. engine registration and adapter wiring.
 */
export function ensureEngineActivation(pi: ExtensionAPI, cwd: string, sessionId?: string): ActivationOutcome {
	const resolved = resolvePinnedActivation(pi, cwd, sessionId);
	if (!resolved.ok) {
		if (resolved.code === "activation_markers_missing") {
			return { ok: false, code: resolved.code, missing: resolved.missing };
		}
		return { ok: false, code: resolved.code, error: resolved.error };
	}
	const owner = resolved.activation.owner;

	let profiles;
	try {
		profiles = loadOmpWorkflowProfiles();
	} catch (error) {
		return { ok: false, code: "profile_invalid", error: String(error instanceof Error ? error.message : error) };
	}

	// The command layer may already hold workflow_registration under this same
	// owner. The core activation seam validates the pinned marker quorum before
	// minting its opaque registration context.
	const activation = openWorkflowActivation(cwd, ALL_CAPABILITIES, owner);
	if (!activation.ok) {
		if (activation.code === "activation_markers_missing") {
			return { ok: false, code: activation.code, missing: missingMarkerPaths(cwd) };
		}
		return { ok: false, code: activation.code, error: activation.error };
	}
	const transaction = beginRegistryRegistration(activation.registry_context, cwd, ["workflow_profiles", "workflow_tools", "constitution_gate", "runtime_config"]);
	if (!transaction.ok) {
		closeWorkflowActivation(activation);
		return { ok: false, code: transaction.code === "owner_conflict" || transaction.code === "owner_invalid" ? transaction.code : "registration_failed", error: transaction.error };
	}
	const rollbackClaims = (): void => {
		try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve downstream failure */ }
		closeWorkflowActivation(activation);
	};

	// Registration presets shared verbatim by engine wiring and the config
	// seed: core's writeRuntimeConfig writes exactly these values when the
	// file is absent and returns untouched when it exists.
	const registrationOpts = {
		label: OMP_INTERNAL_BUNDLE_ID,
		roles: defaultOmpInternalRoles,
		scopeMap: defaultOmpInternalScopeMap,
		scopeRuntimeClasses: defaultOmpInternalScopeRuntimeClasses,
		scopeUiClasses: defaultOmpInternalScopeUiClasses,
		flags: defaultOmpInternalFlags,
		workflowProfiles: profiles,
		resolveCwd: resolveSessionCwd,
		owner,
		cwd,
		registrationToken: transaction.token,
		deferConstitutionGate: true,
	};

	// Seed-if-absent BEFORE the short-circuit and before ANY discovery refresh
	// resolves roles. The owner closure revalidates the pinned root and marker
	// quorum before core can create `.omp/team.config.json`.
	const activationRoot = openActivationRoot(resolved.activation.snapshot);
	if (!activationRoot) {
		rollbackClaims();
		return { ok: false, code: "activation_identity_changed", error: "accepted workspace root or marker identity changed" };
	}
	try {
		writeRuntimeConfig(registrationOpts, cwd, activationRoot);
	} catch (error) {
		rollbackClaims();
		return {
			ok: false,
			code: "registration_failed",
			error: String(error instanceof Error ? error.message : error),
		};
	} finally {
		activationRoot.close();
	}

	if (activatedEngines.has(pi)) {
		try {
			commitRegistryRegistration(transaction.token);
			closeWorkflowActivation(activation);
			const pinned = pinnedActivations.get(pi as object);
			if (pinned && sessionId) pinned.sessionId = sessionId;
			return { ok: true };
		} catch (error) {
			rollbackClaims();
			return { ok: false, code: "registration_failed", error: String(error instanceof Error ? error.message : error) };
		}
	}

	let gateInstallation: InternalGateInstallation | undefined;

	// Registration is the last step and the WeakSet mark lands only AFTER it
	// succeeds (SEC-BUNDLE-001): a throw mid-registration must not leave the
	// host silently marked as wired while zero tools/gates are registered.
	try {
		const installConstitutionGate = registerTeamWorkflow(pi, registrationOpts);
		const adapter: WorkflowToolAdapter = createWorkflowToolAdapter({
			resolveCwd: resolveSessionCwd,
			owner,
			registrationToken: transaction.token,
			// Hand the fresh, provenance-checked mapping to core so workflow_begin
			// authorizes from this session's discovery — in memory, never from the
			// persisted mapping file. A failed refresh rejects here, which blocks
			// the begin (fail closed) instead of letting a stale roster stand in.
			beforeBegin: (currentCwd) => waitForInternalAgentMappings(currentCwd, resolved.activation.snapshot),
		});
		adapter.register(pi);
		// Every activation gets its own registry lease. A process-global key may
		// deduplicate the physical gate implementation, but it must never make a
		// fresh token skip setConstitutionContinuationGate: that would leave the
		// new owner with no live gate after the older lease is revoked.
		const gateKey = `${resolved.activation.snapshot.rootDev}\0${resolved.activation.snapshot.rootIno}\0${activation.claim.principal_fingerprint}`;
		installConstitutionGate?.();
		gateInstallation = { key: gateKey, activation };
		const installations = internalGateInstallations.get(gateKey) ?? new Set<InternalGateInstallation>();
		installations.add(gateInstallation);
		internalGateInstallations.set(gateKey, installations);
		commitRegistryRegistration(transaction.token);
	} catch (error) {
		activatedEngines.delete(pi);
		if (gateInstallation) {
			const installations = internalGateInstallations.get(gateInstallation.key);
			if (installations?.has(gateInstallation)) {
				installations.delete(gateInstallation);
				if (installations.size === 0 && internalGateInstallations.get(gateInstallation.key) === installations) internalGateInstallations.delete(gateInstallation.key);
			}
		}
		rollbackClaims();
		return {
			ok: false,
			code: "registration_failed",
			error: String(error instanceof Error ? error.message : error),
		};
	}
	activatedEngines.add(pi);
	const pinned = pinnedActivations.get(pi as object);
	if (pinned && pinned.retainedLease === undefined) {
		pinned.retainedLease = activation;
		pinned.gateInstallation = gateInstallation;
	}
	if (pinned && sessionId) pinned.sessionId = sessionId;
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
				"code: profile_invalid",
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
 * READ-ONLY validation report: marker check result, activation state for this host, and agent pool listing. The report performs no claims or registration.
 */
function buildValidateReport(pi: ExtensionAPI, cwd: string): string {
	const lines: string[] = ["[omp-workflow-team] validate (read-only) — root: " + cwd];
	const gate = detectWorkspaceMarkers(cwd);
	if (gate.ok) {
		lines.push("markers: OK");
		for (const marker of gate.markers) lines.push("  - " + marker.name + " (" + marker.kind + ")");
	} else {
		lines.push("markers: MISSING (code=" + gate.code + ")");
		for (const marker of gate.missing) lines.push("  - " + marker.name + " (" + marker.kind + ") at " + marker.path);
	}
	const activation = pinnedActivations.get(pi as object);
	const active = activation !== undefined
		&& !activation.revoked
		&& activatedEngines.has(pi as object)
		&& validateWorkspaceActivation(activation.snapshot, cwd).ok;
	lines.push("owners:");
	for (const capability of ALL_CAPABILITIES) {
		lines.push("  - " + capability + ": " + (active ? "active: " + OMP_INTERNAL_BUNDLE_ID : "not active in this host"));
	}
	lines.push("identity:");
	lines.push("  - bundle_id: " + OMP_INTERNAL_BUNDLE_ID);
	lines.push("  - owner_kind: " + OMP_INTERNAL_OWNER_KIND);
	lines.push("  - activation_marker: " + OMP_INTERNAL_ACTIVATION_MARKER);
	lines.push("allowed pool (" + ALLOWED_POOL_AGENTS.length + "):");
	for (const agent of ALLOWED_POOL_AGENTS) lines.push("  - " + agent);
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
				pi.sendUserMessage(buildValidateReport(pi, cwd));
				return;
			}
			const outcome = ensureEngineActivation(pi, cwd, sessionIdentityFromContext(undefined, ctx));
			if (!outcome.ok) {
				pi.sendUserMessage(formatDiagnostic(outcome));
				return;
			}
			const envelope = parseWorkEnvelope(trimmed, cwd);
			if (!envelope.task) {
				pi.sendUserMessage(
					"[omp-workflow-team] Usage: /omp-workflow-team <task description> (or `/omp-workflow-team validate`).",
				);
				return;
			}
			pi.sendUserMessage(buildDoWorkPrompt(envelope, cwd));
		},
	});

	// Namespaced core registration surface: `/omp-do-work`, `/omp-team`,
	// `/omp-cto`. Descriptors mount lazily during a marked session so OMP's
	// slash-suggestion snapshot sees an activated namespace; the marker gate lives in the
	// resolver and the retained owner source, so an unmarked session claims
	// zero owners and never receives a workflow dispatch. Core registers its
	// own session_start claim handler here — it must run BEFORE the
	// engine-activation handler below so `workflow_registration` is claimed
	// first and `ensureEngineActivation` then idempotently claims all three
	// capabilities under the single private owner.
	registerWorkflowCommands(pi, {
		namespace: COMMAND_NAMESPACE,
		...NAMESPACED_DESCRIPTIONS,
		owner: pinnedOwnerSourceFor(pi),
		resolveCwd: resolveGatedCommandCwd,
	});

	if (!internalShutdownHandlers.has(pi as object)) {
		internalShutdownHandlers.add(pi as object);
		pi.on("session_shutdown", (event: unknown, ctx: unknown) => {
			const activation = pinnedActivations.get(pi as object);
			if (!activation) return;
			const generation = sessionIdentityFromContext(event, ctx);
			// A retained activation created for an identified host generation can
			// only be closed by that exact generation; late events from a prior
			// session must never evict a replacement activation. Teardown is
			// token-based: marker/root validation is deliberately not required, so
			// deleting a workspace cannot leak its retained owner lease.
			if (activation.sessionId && (!generation || generation !== activation.sessionId)) return;
			revokePinnedActivation(activation);
			pinnedActivations.delete(pi as object);
			activatedEngines.delete(pi as object);
		});
	}

	pi.on("session_start", (event: unknown, ctx: unknown) => {
		const cwd = resolveSessionCwd(ctx);
		if (!cwd) return;
		// Activation FIRST: on a clean marked workspace it synchronously seeds
		// the default omp-* role config (write-if-absent), so the refresh
		// kicked below resolves real roles on the very first session instead
		// of failing closed on empty config until a second session_start.
		const outcome = ensureEngineActivation(pi, cwd, sessionIdentityFromContext(event, ctx));
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
		// republishes the exact omp-* role mapping. It is kicked only after a
		// successful pinned activation + config seed, so a revoked root cannot
		// create `.work-state` or mapping state in a replacement workspace.
		const activation = pinnedActivations.get(pi as object);
		if (outcome.ok && activation) {
			void refreshInternalAgentMappings(cwd, activation.snapshot).catch((error: unknown) => {
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
}
