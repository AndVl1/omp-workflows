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
 * Command surface: exactly one command, hyphen-named `omp-workflow-team`.
 * Bare `do-work` / `team` / `cto` names are never registered and
 * `omp-model-roles` is never shadowed. `omp-workflow-team validate` is a
 * strictly read-only mode.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	buildDoWorkPrompt,
	claimWorkflowOwners,
	createWorkflowToolAdapter,
	parseWorkEnvelope,
	registerTeamWorkflow,
	workflowOwnerFor,
	type WorkflowCapability,
	type WorkflowToolAdapter,
} from "@andvl1/omp-workflows-core";

import { detectWorkspaceMarkers } from "./activation.js";
import {
	OMP_INTERNAL_ACTIVATION_MARKER,
	OMP_INTERNAL_BUNDLE_ID,
	OMP_INTERNAL_OWNER_KIND,
	privateOmpOwnerForCwd,
} from "./identity.js";
import {
	ALLOWED_POOL_AGENTS,
	defaultOmpInternalFlags,
	defaultOmpInternalRoles,
	defaultOmpInternalScopeMap,
	defaultOmpInternalScopeRuntimeClasses,
	defaultOmpInternalScopeUiClasses,
} from "./pool.js";
import { loadOmpWorkflowProfiles } from "./profiles.js";

const ALL_CAPABILITIES: readonly WorkflowCapability[] = [
	"workflow_registration",
	"workflow_tools",
	"config_writer",
];

const COMMAND_NAME = "omp-workflow-team";

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
 *     aborts before the registry mutates and before ANY engine registration.
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
	if (activatedEngines.has(pi)) return { ok: true };

	// Registration is the last step and the WeakSet mark lands only AFTER it
	// succeeds (SEC-BUNDLE-001): a throw mid-registration must not leave the
	// host silently marked as wired while zero tools/gates are registered.
	try {
		registerTeamWorkflow(pi, {
			label: OMP_INTERNAL_BUNDLE_ID,
			roles: defaultOmpInternalRoles,
			scopeMap: defaultOmpInternalScopeMap,
			scopeRuntimeClasses: defaultOmpInternalScopeRuntimeClasses,
			scopeUiClasses: defaultOmpInternalScopeUiClasses,
			flags: defaultOmpInternalFlags,
			workflowProfiles: profiles,
			resolveCwd: resolveSessionCwd,
			owner: privateOmpOwnerForCwd,
		});
		const adapter: WorkflowToolAdapter = createWorkflowToolAdapter({
			resolveCwd: resolveSessionCwd,
			owner: privateOmpOwnerForCwd,
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

	pi.on("session_start", (_event: unknown, ctx: unknown) => {
		const cwd = resolveSessionCwd(ctx);
		if (!cwd) return;
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
	});
}
