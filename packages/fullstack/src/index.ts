/**
 * @andvl1/omp-workflows-fullstack — default omp-workflows bundle.
 * Registers the workflow and model-role commands synchronously through
 * ExtensionAPI.registerCommand. Supported OMP hosts therefore never need
 * project-local compatibility command files at session start.
 *
 * Also wires the live subagent-tree widget (see `subagent-tree.ts`) and
 * exposes a `/subagents` toggle command.
 *
 * For a custom bundle, write an own package with a project-local physical
 * activation marker. Its canonical owner/resolver must be passed explicitly to
 * `registerTeamWorkflow`, `createWorkflowToolAdapter`, and
 * `registerWorkflowCommands`; the first two also receive the authenticated
 * opaque registry transaction token. See docs/adding-agents.md for the complete
 * marker-bound lifecycle.
 * Core owns the shipped native specification workflow (constitution bootstrap
 * + spec-preparation); this bundle contributes its native provider and
 * deterministic recognizers/templates through the authenticated registry.
 *
 */

import { createHash, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionUIContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@oh-my-pi/pi-coding-agent";
import {
  createWorkflowToolAdapter,
  registerConstitutionTools,
  registerCtoTools,
  PinnedProjectRoot,
  NATIVE_CONSTITUTION_PROVIDER_ID,
  NATIVE_CONSTITUTION_TEMPLATE,
  registerFormatRecognizer,
  registerConstitutionProvider,
  registerTeamWorkflow,
  readAgentMapping,
  resolveSpecificationTemplateSet,
  SHIPPED_SPECIFICATION_TEMPLATE_IDS,
  EscalationConfigError,
  hydrateNativeSpecificationWorkerPrompt,
  type ModelRoleEntry,
  type RoleConfig,
  type ScopeRuntimeClassTable,
  type TeamSessionBindingController,
  type TeamSessionRuntimeBinding,
 } from "@andvl1/omp-workflows-core";
import {
  beginRegistryRegistration,
  closeWorkflowActivation,
  createRegistryRegistrationLiveGuard,
  openWorkflowActivation,
  commitRegistryRegistration,
  rollbackRegistryRegistration,
  type RegistryRegistrationContext,
  type RegistryContextSnapshot,
  type RegistryRegistrationToken,
  type WorkflowActivationResult,
  type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core/registry";
import { createCtoRuntimeAccessGuardedView, ctoRuntimeSessionAuthorityForContext, openCtoRuntimeAccess, openCtoRuntimeProofAuthority, openCtoRuntimeServiceMutationAuthority, registerCtoRuntimeAccessProvider, revokeCtoRuntimeProofAuthority, revokeCtoRuntimeServiceMutationAuthority } from "@andvl1/omp-workflows-core/cto-runtime";
import type { CtoRuntimeAccessFacade, CtoRuntimeAccessSession, CtoRuntimeProofAuthority, CtoRuntimeServiceMutationAuthority } from "@andvl1/omp-workflows-core/cto-runtime";
import { registerWorkflowCommands } from "./workflow-commands.js";
import { defaultFullstackModelRoles, registerModelRolesCommand } from "./model-roles.js";
export { defaultFullstackModelRoles } from "./model-roles.js";
import { clearFullstackAgentMappings, refreshFullstackAgentMappings, waitForFullstackAgentMappings } from "./agent-mapping.js";
import { createChannelSet, inboxDir, inboxMessageFileName, queueCtoDelivery, startChannelDispatcher, type InboxTask } from "./adapters/registry.js";
import { createAskRedirectGate } from "./messenger-channel.js";
import { activateCtoMode, bindCtoRuntimeAccess, createCtoModeReminderHandler, deactivateCtoMode, sessionIdFromContext } from "./cto-mode-reminder.js";
import {
  NATIVE_WORKER_INPUT_MARKER,
  NATIVE_WORKER_INPUT_REFERENCE_MARKER,
  RESEARCH_REQUEST_MARKER_END,
  RESEARCH_REQUEST_MARKER_START,
  buildNativeSpecificationDeveloperInstruction,
  buildResearchRequestDeveloperInstruction,
  buildResearchRequestAuthorizationEnvelope,
  extractResearchRequestAuthorizationEnvelope,
  extractNativeWorkerInputReference,
  hasNativeWorkerInputMarker,
  hasNativeWorkerInputReferenceToken,
} from "./before-agent-start-marker.js";
import {
  handleSubagentsCommand,
  registerSubagentTree,
  type SubagentTreeController,
} from "./subagent-tree.js";
import { registerLectureAcquireTool } from "./tools/lecture-acquire.js";
import { specificationRecognizers } from "./specification/recognizers/registry.js";
import { FULLSTACK_ACTIVATION_MARKER_PATH, FULLSTACK_ACTIVATION_MARKER_SHA256 } from "./activation-marker.js";
import {
  SPECKIT_CONSTITUTION_PROVIDER_ID,
  speckitConstitutionProvider,
} from "./specification/providers/speckit.js";
// Auto-derived from core taxonomy; test-invariант в test/omp-model-roles.test.ts:439-446 ловит drift.
const ESCALATION_CONFIG_BLOCKED_NOTICE = "CTO escalation channel configuration blocked; dispatcher disabled.";


export const defaultFullstackRoles: RoleConfig["roles"] = {
  analyst: "analyst",
  "specification-analyst": "specification-worker",
  "tech-researcher": "tech-researcher",
  diagnostics: "diagnostics",
  architect: "architect",
  "specification-architect": "specification-worker",
  "backend-kotlin": "developer-kotlin",
  go: "developer-go",
  frontend: "frontend-developer",
  mobile: "developer-mobile",
  android: "developer-mobile",
  qa: "qa",
  "manual-qa": "manual-qa",
  "code-reviewer": "code-reviewer",
  "security-tester": "security-tester",
  devops: "devops",
  "regression-planner": "analyst",
  "regression-executor": "manual-qa",
  "regression-oracle": "qa",
  "product-analyst": "product-analyst",
  "product-researcher": "product-researcher",
  "product-critic": "product-critic",
  "product-strategist": "product-strategist",
};

export const defaultFullstackScopeMap: RoleConfig["scope_map"] = [
  { glob: ["**/iosApp/**", "**/composeApp/**", "**/commonMain/**", "**/androidMain/**"], scope: "mobile", dev_agent: "developer-mobile" },
  { glob: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.ts", "**/src/jsMain/**", "**/miniapp/**", "**/frontend/**"], scope: "frontend", dev_agent: "frontend-developer" },
  { glob: ["**/*.go", "**/go.mod", "**/go.sum"], scope: "go", dev_agent: "developer-go" },
  { glob: ["**/Dockerfile", "**/*.yaml", "**/*.yml", "**/helm/**", "**/.github/**", "**/k8s/**"], scope: "devops", dev_agent: "devops" },
  { glob: ["**/*.kt", "**/*.java", "**/src/main/**"], scope: "backend-kotlin", dev_agent: "developer-kotlin" },
];

export const defaultFullstackFlags: RoleConfig["flags"] = {
  has_security: ["**/auth/**", "**/security/**", "**/*crypto*", "**/*Secret*", "**/*Token*"],
  has_infra: ["**/Dockerfile", "**/helm/**", "**/k8s/**", "**/.github/workflows/**"],
};

/** Domain runtime classification moved out of the core default path (INT-001). */
export const defaultFullstackScopeRuntimeClasses: ScopeRuntimeClassTable = {
	"backend-kotlin": "runtime",
	go: "runtime",
	frontend: "runtime",
	mobile: "runtime",
	devops: "runtime",
};

/** Domain UI scopes moved out of the core default path (INT-001). */
export const defaultFullstackScopeUiClasses: ScopeRuntimeClassTable = {
	frontend: true,
	mobile: true,
};

export interface FullstackPreset {
  roles: RoleConfig["roles"];
  scopeMap: RoleConfig["scope_map"];
  flags: RoleConfig["flags"];
  scopeRuntimeClasses: ScopeRuntimeClassTable;
  scopeUiClasses: ScopeRuntimeClassTable;
  modelRoles: readonly ModelRoleEntry[];
}

export const fullstackPreset: FullstackPreset = {
  roles: defaultFullstackRoles,
  scopeMap: defaultFullstackScopeMap,
  flags: defaultFullstackFlags,
  scopeRuntimeClasses: defaultFullstackScopeRuntimeClasses,
  scopeUiClasses: defaultFullstackScopeUiClasses,
  modelRoles: defaultFullstackModelRoles,
};
// Auto-derived from the explicit fullstack taxonomy; tests guard drift.
const ROLE_COUNT = defaultFullstackModelRoles.length;

/**
 * Resolve the session project root for hooks and workflow tools.
 *
 * The session manager is authoritative across resume/switch operations. Some
 * OMP runtimes omit `cwd` from lifecycle/tool contexts, while other versions
 * can leave the copied context value stale after a session move; using the
 * manager first keeps commands and durable transitions on the same worktree.
 * A missing cwd remains unavailable; the process cwd is never substituted.
 */
function isSafeSessionCwd(value: unknown): value is string {
	return typeof value === "string"
		&& value.trim().length > 0
		&& !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function isPlainContextObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		return Object.prototype.toString.call(value) === "[object Object]";
	} catch {
		return false;
	}
}

export function resolveSessionCwd(ctx: unknown): string | undefined {
	if (!isPlainContextObject(ctx)) return undefined;
	let manager: unknown;
	try { manager = ctx.sessionManager; } catch { return undefined; }
	if (manager !== undefined && manager !== null) {
		if (!isPlainContextObject(manager)) return undefined;
		try {
			if (!("getCwd" in manager) || typeof manager.getCwd !== "function") return undefined;
			const sessionCwd = manager.getCwd();
			return isSafeSessionCwd(sessionCwd) ? sessionCwd : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		return isSafeSessionCwd(ctx.cwd) ? ctx.cwd : undefined;
	} catch {
		return undefined;
	}
}

interface NativeWorkerSessionContext {
	readonly cwd: string;
	readonly session_id: string;
	readonly session_file: string;
	readonly session_dir: string;
}

function resolveNativeWorkerSessionContext(ctx: unknown): NativeWorkerSessionContext | null {
	if (!isPlainContextObject(ctx)) return null;
	let manager: unknown;
	try { manager = ctx.sessionManager; } catch { return null; }
	if (!isPlainContextObject(manager)) return null;
	try {
		if (typeof manager.getCwd !== "function"
			|| typeof manager.getSessionId !== "function"
			|| typeof manager.getSessionFile !== "function"
			|| typeof manager.getSessionDir !== "function") return null;
		const cwd = manager.getCwd();
		const sessionId = manager.getSessionId();
		const sessionFile = manager.getSessionFile();
		const sessionDir = manager.getSessionDir();
		if (!isSafeSessionCwd(cwd)
			|| typeof sessionId !== "string" || sessionId.trim().length === 0
			|| !isSafeSessionCwd(sessionFile)
			|| !isSafeSessionCwd(sessionDir)) return null;
		const canonicalFile = resolve(sessionFile);
		const canonicalDir = resolve(sessionDir);
		const child = relative(canonicalDir, canonicalFile);
		if (!child || child === ".." || child.startsWith(".." + sep) || isAbsolute(child)) return null;
		return {
			cwd,
			session_id: sessionId,
			session_file: canonicalFile,
			session_dir: canonicalDir,
		};
	} catch {
		return null;
	}
}

/** Open and pin the session root; the pin derives canonical identity atomically. */
function openSessionRoot(cwd: string): PinnedProjectRoot | null {
	return PinnedProjectRoot.open(cwd);
}
function summarizeAgentMapping(cwd: string): {
  generated_at: string;
  available_agents: string[];
  fallback_roles: string[];
  unresolved_roles: string[];
} | null {
  const mapping = readAgentMapping(cwd);
  if (!mapping) return null;
  return {
    generated_at: mapping.generated_at,
    available_agents: mapping.available_agents,
    fallback_roles: Object.entries(mapping.diagnostics)
      .filter(([, diagnostic]) => diagnostic.status === "fallback")
      .map(([role]) => role),
    unresolved_roles: mapping.unresolved_roles,
  };
}

/**
 * Extract the ExtensionUIContext from a session_start ctx. The OMP
 * extension API exposes `ui` on context objects at runtime but the bundled
 * `.d.ts` narrows session_start ctx to a subset; hand-narrow at the
 * boundary instead of an unchecked cast.
 */
function extractUiFromContext(ctx: unknown): ExtensionUIContext | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	if (!("ui" in ctx)) return undefined;
	const candidate = (ctx as { ui: unknown }).ui;
	return candidate && typeof candidate === "object" ? (candidate as ExtensionUIContext) : undefined;
}

/**
 * Resolve the lifecycle owner from the canonical session manager first.
 * Raw sessionId/session_id fields are compatibility fallbacks only when no
 * manager is exposed; a present manager remains authoritative even when its
 * getter fails or returns an unusable value.
 */
function lifecycleSessionId(event: unknown, ctx: unknown): string | undefined {
	let managerSeen = false;
	for (const source of [ctx, event]) {
		if (!source || typeof source !== "object") continue;
		const manager = (source as { sessionManager?: unknown }).sessionManager;
		if (!manager || typeof manager !== "object") continue;
		managerSeen = true;
		if (!("getSessionId" in manager) || typeof manager.getSessionId !== "function") continue;
		try {
			const value = (manager.getSessionId as () => unknown)();
			if (typeof value === "string" && value.trim().length > 0) return value;
		} catch {
			// A present manager is still authoritative; do not fall back to raw fields.
		}
	}
	if (managerSeen) return undefined;
	const fallback = sessionIdFromContext(event, ctx);
	return typeof fallback === "string" && fallback.trim().length > 0 ? fallback : undefined;
}

/**
 * `before_agent_start` hook for the two extension-owned marker contracts.
 * The native specification marker is a developer-priority closed mode; the
 * model-roles marker retains its existing research delegation. If both are
 * present, one composed result is returned for compatibility with hosts that
 * keep only the first message, with native mode last as the higher precedence.
 */
export function beforeAgentStartMarkerHandler(
	event: BeforeAgentStartEvent,
): BeforeAgentStartEventResult | undefined {
	if (typeof event?.prompt !== "string") return undefined;
	const nativeWorkerMode = hasNativeWorkerInputMarker(event.prompt);
	const researchRequestMode = event.prompt.includes(RESEARCH_REQUEST_MARKER_START)
		&& event.prompt.includes(RESEARCH_REQUEST_MARKER_END);
	if (!nativeWorkerMode && !researchRequestMode) return undefined;

	const nativeMessage = nativeWorkerMode
		? {
				customType: "omp-native-specification-worker-mode",
				content: buildNativeSpecificationDeveloperInstruction(),
				display: true,
				details: {
					kind: "omp-native-specification-worker-mode",
					schemaVersion: 1,
					marker: NATIVE_WORKER_INPUT_MARKER,
				},
				attribution: "agent" as const,
			}
		: undefined;
	const researchMessage = researchRequestMode
		? {
				customType: "omp-model-roles-research-instructions",
				content: buildResearchRequestDeveloperInstruction(ROLE_COUNT),
				display: true,
				// `details` carries the marker contract advertised to recipients
				// (custom UI, downstream tooling). It mirrors the top-level
				// fields of the in-payload `ResearchRequest` (see
				// `@andvl1/omp-workflows-core` model-roles module and
				// `buildResearchPrompt`) without re-parsing the prompt: the
				// full inventory lives inside the marker payload and is
				// duplicated here only as a count.
				details: {
					kind: "omp-model-role-research-request",
					schemaVersion: 1,
					requestedAt: new Date().toISOString(),
					roleCount: ROLE_COUNT,
					// `modelCount` is intentionally `null`: counting requires
					// parsing the embedded JSON payload, which we deliberately
					// avoid in the hook (re-parse + re-validate of a payload
					// the LLM already sees). Receivers that need the actual
					// list must read it from the payload, keeping the two
					// in sync.
					modelCount: null,
				},
				attribution: "agent" as const,
			}
		: undefined;

	if (nativeMessage && researchMessage) {
		// OMP 17.x hosts keep the first returned message while newer hosts
		// retain all messages. Collapse both markers into one deterministic
		// message and put native mode last so its higher precedence is stable
		// on every host; the native instruction explicitly overrides generic
		// role instructions for this child invocation.
		return {
			message: {
				customType: "omp-native-specification-worker-mode",
				content: [researchMessage.content, nativeMessage.content].join("\n\n"),
				display: true,
				details: {
					kind: "omp-native-specification-worker-mode",
					schemaVersion: 1,
					marker: NATIVE_WORKER_INPUT_MARKER,
					composedMarkers: ["omp-model-roles-research-request", NATIVE_WORKER_INPUT_MARKER],
				},
				attribution: "agent",
			},
		};
	}
	if (nativeMessage) return { message: nativeMessage };
	return { message: researchMessage! };
}

/**
 * Per-session subagent-tree controller. Filled by session_start; consumed by
 * the `/subagents` command handler. Ref pattern keeps the handler registered
 * once at extension load while the controller is bound at session start.
 */
const subagentTreeRef: { current: SubagentTreeController | null } = { current: null };

function abortNativeWorker(ctx: unknown): void {
  if (!isPlainContextObject(ctx)) return;
  try {
    if (typeof ctx.abort === "function") ctx.abort();
  } catch {
    // Host abort is best effort; the inert failure result still prevents hydration.
  }
}

function nativeWorkerFailureResult(reference: ReturnType<typeof extractNativeWorkerInputReference>, code = "NATIVE_WORKER_INPUT_UNAVAILABLE"): BeforeAgentStartEventResult {
  const safeCode = typeof code === "string" ? code.replace(/[^A-Z0-9_]/g, "_").slice(0, 64) || "NATIVE_WORKER_INPUT_UNAVAILABLE" : "NATIVE_WORKER_INPUT_UNAVAILABLE";
  const suffix = reference ? " ref=" + reference.ref + " digest=" + reference.digest : "";
  return {
    message: {
      customType: "omp-native-specification-worker-mode-failed",
      content: "Native specification worker input could not be hydrated; this authenticated worker invocation was aborted (" + safeCode + ")." + suffix,
      display: true,
      details: {
        kind: "omp-native-specification-worker-mode-failed",
        schemaVersion: 1,
        marker: NATIVE_WORKER_INPUT_REFERENCE_MARKER,
        code: safeCode,
      },
      attribution: "agent",
    },
  };
}

interface NativeWorkerDisplayMessage {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details: Record<string, unknown>;
  readonly attribution: "agent";
}

function nativeWorkerDisplayMessage(reference: NonNullable<ReturnType<typeof extractNativeWorkerInputReference>>): NativeWorkerDisplayMessage {
  return {
    customType: "omp-native-specification-worker-mode",
    content: "Authenticated native specification worker input: ref=" + reference.ref + " digest=" + reference.digest + ". Full input is injected for this turn only.",
    display: true,
    details: {
      kind: "omp-native-specification-worker-mode",
      schemaVersion: 1,
      marker: NATIVE_WORKER_INPUT_REFERENCE_MARKER,
      ref: reference.ref,
      digest: reference.digest,
    },
    attribution: "agent",
  };
}

function nativeWorkerFailureCanAbort(hydrated: Extract<ReturnType<typeof hydrateNativeSpecificationWorkerPrompt>, { ok: false }>): boolean {
  // The hydrator marks failures as authenticated_assignment only after the
  // exact engine prompt, reference, dispatch, and worker-session boundary
  // are bound. All earlier failures remain inert so marker-shaped user or
  // Telegram text can never abort a host.
  return "provenance" in hydrated && hydrated.provenance === "authenticated_assignment";
}

function isNativeWorkerContext(ctx: unknown): ctx is Record<string, unknown> {
  if (!isPlainContextObject(ctx)) return false;
  try { return ctx.hasUI === false; } catch { return false; }
}

function guardedBeforeAgentStartMarkerHandler(
  pi: ExtensionAPI,
  event: BeforeAgentStartEvent,
  ctx: unknown,
): BeforeAgentStartEventResult | undefined {
  if (typeof event?.prompt !== "string") return undefined;
  const nativeReference = extractNativeWorkerInputReference(event.prompt);
  const nativeReferenceToken = hasNativeWorkerInputReferenceToken(event.prompt);
  const legacyNativeToken = hasNativeWorkerInputMarker(event.prompt);
  const authorizedResearchPayload = extractResearchRequestAuthorizationEnvelope(event.prompt);
  const consumeAuthorizedResearch = (): BeforeAgentStartEventResult | undefined => {
    if (authorizedResearchPayload === null || consumeResearchRequestAuthorization(pi, ctx, event.prompt) === null) return undefined;
    const requestedCwd = resolveSessionCwd(ctx);
    if (!requestedCwd || !ensureFullstackLiveRoot(pi, ctx, requestedCwd, false)) return undefined;
    return beforeAgentStartMarkerHandler({
      ...event,
      prompt: RESEARCH_REQUEST_MARKER_START + "\n" + authorizedResearchPayload.payload + "\n" + RESEARCH_REQUEST_MARKER_END,
    });
  };
  if (!nativeReference && !nativeReferenceToken && !legacyNativeToken && authorizedResearchPayload === null) return undefined;

  // Native mode is worker-only. The non-UI marker contract is checked before
  // reading a reference or touching activation state, so ordinary user and
  // Telegram prompts carrying marker-shaped text are inert.
  if (nativeReferenceToken || legacyNativeToken || nativeReference) {
    if (!nativeReference || !isNativeWorkerContext(ctx)) return consumeAuthorizedResearch();
    const session = resolveNativeWorkerSessionContext(ctx);
    if (!session) return consumeAuthorizedResearch();
    const liveRoot = currentFullstackLiveRoot(pi, ctx, session.cwd);
    if (!liveRoot) return consumeAuthorizedResearch();
    let hydrated: ReturnType<typeof hydrateNativeSpecificationWorkerPrompt>;
    try {
      hydrated = hydrateNativeSpecificationWorkerPrompt(liveRoot, {
        prompt: event.prompt,
        session_id: session.session_id,
        session_file: session.session_file,
        session_dir: session.session_dir,
      });
    } catch {
      return consumeAuthorizedResearch();
    }
    if (!hydrated.ok || typeof hydrated.system_prompt !== "string" || hydrated.system_prompt.length === 0) {
      if (!hydrated.ok && nativeWorkerFailureCanAbort(hydrated)) {
        abortNativeWorker(ctx);
        return nativeWorkerFailureResult(nativeReference, hydrated.code);
      }
      return consumeAuthorizedResearch();
    }

    const nativeMessage = nativeWorkerDisplayMessage(nativeReference);
    const researchResult = consumeAuthorizedResearch();
    const researchMessage = researchResult?.message;
    const message = researchMessage
      ? {
          customType: "omp-native-specification-worker-mode",
          content: String(typeof researchMessage === "string" ? researchMessage : researchMessage?.content ?? "") + "\n\n" + nativeMessage.content,
          display: true,
          details: {
            kind: "omp-native-specification-worker-mode",
            schemaVersion: 1,
            marker: NATIVE_WORKER_INPUT_REFERENCE_MARKER,
            ref: nativeReference.ref,
            digest: nativeReference.digest,
            composedMarkers: ["omp-model-roles-research-request", NATIVE_WORKER_INPUT_REFERENCE_MARKER],
          },
          attribution: "agent" as const,
        }
      : nativeMessage;
    const baseSystemPrompt = Array.isArray(event.systemPrompt) ? event.systemPrompt : [];
    return {
      message,
      systemPrompt: [
        ...baseSystemPrompt,
        buildNativeSpecificationDeveloperInstruction(),
        hydrated.system_prompt,
      ],
    };
  }

  // Raw/legacy research markers are ordinary user text. Only the exact
  // command-issued envelope, consumed above, may activate developer mode.
  return consumeAuthorizedResearch();
}

/** One dispatcher per interactive main session/root identity; subagents must not poll Telegram. */
interface DispatcherSlot {
	readonly owner: string;
  readonly sessionManager?: object;
	readonly rootIdentity: string;
	readonly lexicalRoot: string;
	readonly cwd: string;
	readonly generation: number;
	readonly sessionFile?: string;
  readonly sessionGeneration?: string | number;
	readonly stop: () => Promise<void>;
}
interface DispatcherOwnership {
	readonly owner: string;
  readonly sessionManager?: object;
	readonly rootIdentity: string;
  /** Canonical cwd observed from SessionManager at start; root identity alone
   * does not detect a manager moving between directories in one project. */
  readonly cwd: string;
	readonly generation: number;
	readonly sessionFile?: string;
  readonly sessionGeneration?: string | number;
}

interface PendingCtoWake extends DispatcherOwnership {
  readonly token: string;
  readonly kind: CtoWakeReferenceKind;
  readonly runId: string;
  readonly id: string;
  readonly digest: string;
  readonly stateRevision: number;
  readonly runtimeAccess: CtoRuntimeAccessFacade;
  readonly completion: {
    settled: boolean;
    resolve: () => void;
    reject: (error: unknown) => void;
    readonly promise: Promise<void>;
  };
  readonly pin: PinnedProjectRoot;
}
/** One dispatcher per immutable project-root identity; aliases share a slot. */
const dispatcherStopsByRootIdentity = new Map<string, DispatcherSlot>();
/** Ownership is stable under the ExtensionAPI and includes the immutable root,
 * authoritative session id/file, and monotonic start generation. The manager
 * token is only a legacy fallback for contexts that omit getSessionFile(). */
const dispatcherOwnershipByPi = new WeakMap<object, Map<string, DispatcherOwnership>>();
const dispatcherCurrentOwnershipByPi = new WeakMap<object, DispatcherOwnership>();
const dispatcherGenerationByManagerByPi = new WeakMap<object, WeakMap<object, number>>();
const dispatcherRetiredManagersByPi = new WeakMap<object, WeakMap<object, Set<string>>>();
const dispatcherPendingManagerByPi = new WeakMap<object, object>();
const dispatcherPendingManagerIdentityByPi = new WeakMap<object, DispatcherContextIdentity>();
const MAX_RETIRED_HOST_GENERATIONS = 32;
let nextDispatcherGeneration = 0;

function rememberDispatcherManagerGeneration(pi: ExtensionAPI, ctx: unknown, generation: number): void {
  const manager = authoritativeSessionManager(ctx);
  if (!manager) return;
  const byManager = dispatcherGenerationByManagerByPi.get(pi as object) ?? new WeakMap<object, number>();
  byManager.set(manager, generation);
  dispatcherGenerationByManagerByPi.set(pi as object, byManager);
}

function dispatcherManagerGeneration(pi: ExtensionAPI, ctx: unknown): number | undefined {
  const manager = authoritativeSessionManager(ctx);
  return manager ? dispatcherGenerationByManagerByPi.get(pi as object)?.get(manager) : undefined;
}

function dispatcherRootIdentity(pinnedRoot: PinnedProjectRoot): string {
	return JSON.stringify([pinnedRoot.canonical_root, pinnedRoot.dev, pinnedRoot.ino]);
}

interface DispatcherContextIdentity extends DispatcherOwnership {
  readonly sessionManager: object;
	readonly lexicalRoot: string;
	readonly cwd: string;
}

function authoritativeSessionManager(ctx: unknown): Record<string, unknown> | null {
	if (!isPlainContextObject(ctx)) return null;
	let manager: unknown;
	try { manager = ctx.sessionManager; } catch { return null; }
	return isPlainContextObject(manager) ? manager : null;
}

function sessionGenerationFromManager(manager: Record<string, unknown>): string | number | undefined {
  if (typeof manager.getSessionGeneration !== "function") return undefined;
  try {
    const value = manager.getSessionGeneration();
    return validHostGeneration(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sessionFileFromManager(manager: Record<string, unknown>): string | undefined {
	if (typeof manager.getSessionFile !== "function") return undefined;
	try {
		const value = manager.getSessionFile();
		return isSafeSessionCwd(value) ? resolve(value) : undefined;
	} catch {
		return undefined;
	}
}

function dispatcherContextIdentity(ctx: unknown): DispatcherContextIdentity | null {
	const manager = authoritativeSessionManager(ctx);
	if (!manager || typeof manager.getCwd !== "function" || typeof manager.getSessionId !== "function") return null;
	try {
		const cwd = manager.getCwd();
		const owner = manager.getSessionId();
		if (!isSafeSessionCwd(cwd) || !isSafeSessionCwd(owner)) return null;
		const pinnedRoot = openSessionRoot(cwd);
		if (!pinnedRoot) return null;
		try {
			if (!pinnedRoot.isStable()) return null;
			return {
				owner,
				sessionManager: manager,
				rootIdentity: dispatcherRootIdentity(pinnedRoot),
				lexicalRoot: pinnedRoot.lexical_root,
				cwd: pinnedRoot.canonical_root,
				sessionFile: sessionFileFromManager(manager),
				sessionGeneration: sessionGenerationFromManager(manager),
				generation: 0,
			};
		} finally {
			pinnedRoot.close();
		}
	} catch {
		return null;
	}
}

function dispatcherOwnershipKey(ownership: Pick<DispatcherOwnership, "owner" | "rootIdentity" | "cwd" | "generation" | "sessionFile" | "sessionGeneration">): string {
	return JSON.stringify([ownership.owner, ownership.rootIdentity, ownership.cwd, ownership.generation, ownership.sessionFile ?? null, ownership.sessionGeneration ?? null]);
}

function validHostGeneration(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 512)
    || (typeof value === "number" && Number.isSafeInteger(value));
}

function managerIdentityKey(identity: Pick<DispatcherOwnership, "owner" | "rootIdentity" | "cwd" | "sessionFile" | "sessionGeneration">): string {
  return JSON.stringify([identity.owner, identity.rootIdentity, identity.cwd, identity.sessionFile ?? null, identity.sessionGeneration ?? null]);
}

function retireDispatcherManager(pi: ExtensionAPI, identity: Pick<DispatcherOwnership, "sessionManager" | "owner" | "rootIdentity" | "cwd" | "sessionFile" | "sessionGeneration">): void {
  const manager = identity.sessionManager;
  if (!manager) return;
  const retired = dispatcherRetiredManagersByPi.get(pi as object) ?? new WeakMap<object, Set<string>>();
  const identities = retired.get(manager) ?? new Set<string>();
  identities.delete(managerIdentityKey(identity));
  identities.add(managerIdentityKey(identity));
  while (identities.size > MAX_RETIRED_HOST_GENERATIONS) {
    const oldest = identities.values().next().value;
    if (typeof oldest !== "string") break;
    identities.delete(oldest);
  }
  retired.set(manager, identities);
  dispatcherRetiredManagersByPi.set(pi as object, retired);
}

function isRetiredDispatcherManager(pi: ExtensionAPI, identity: Pick<DispatcherOwnership, "sessionManager" | "owner" | "rootIdentity" | "cwd" | "sessionFile" | "sessionGeneration">): boolean {
  return identity.sessionManager ? dispatcherRetiredManagersByPi.get(pi as object)?.get(identity.sessionManager)?.has(managerIdentityKey(identity)) === true : false;
}

function rememberDispatcherOwnership(pi: ExtensionAPI, ownership: DispatcherOwnership): void {
  const previous = dispatcherCurrentOwnershipByPi.get(pi as object);
  if (previous?.sessionManager && (previous.sessionManager !== ownership.sessionManager
      || (previous.sessionGeneration ?? null) !== (ownership.sessionGeneration ?? null)
      || previous.owner !== ownership.owner || previous.rootIdentity !== ownership.rootIdentity || previous.cwd !== ownership.cwd
      || (previous.sessionFile ?? null) !== (ownership.sessionFile ?? null))) retireDispatcherManager(pi, previous);
	const entries = dispatcherOwnershipByPi.get(pi as object) ?? new Map<string, DispatcherOwnership>();
	entries.set(dispatcherOwnershipKey(ownership), ownership);
	// Keep ownership memory bounded while retaining every currently active root.
	const current = dispatcherCurrentOwnershipByPi.get(pi as object);
	for (const [key, candidate] of entries) {
		if (entries.size <= 32) break;
		if (current && candidate.generation === current.generation && candidate.rootIdentity === current.rootIdentity && candidate.owner === current.owner) continue;
		entries.delete(key);
	}
	dispatcherOwnershipByPi.set(pi as object, entries);
	dispatcherCurrentOwnershipByPi.set(pi as object, ownership);
}

function forgetDispatcherOwnership(pi: ExtensionAPI, ownership: DispatcherOwnership): void {
	const entries = dispatcherOwnershipByPi.get(pi as object);
	entries?.delete(dispatcherOwnershipKey(ownership));
	if (entries && entries.size === 0) dispatcherOwnershipByPi.delete(pi as object);
	if (dispatcherCurrentOwnershipByPi.get(pi as object)?.generation === ownership.generation) dispatcherCurrentOwnershipByPi.delete(pi as object);
}

function ownershipForContext(pi: ExtensionAPI, ctx: unknown, identity: DispatcherContextIdentity): DispatcherOwnership | undefined {
	const entries = dispatcherOwnershipByPi.get(pi as object);
	if (!entries) return undefined;
	for (const ownership of entries.values()) {
		if (ownership.owner !== identity.owner || ownership.rootIdentity !== identity.rootIdentity || ownership.cwd !== identity.cwd) continue;
		if ((ownership.sessionFile ?? null) !== (identity.sessionFile ?? null)) continue;
    const managerGeneration = dispatcherManagerGeneration(pi, ctx);
    if (managerGeneration === undefined || managerGeneration !== ownership.generation) continue;
		return ownership;
	}
	return undefined;
}

function dispatcherIdentityMatches(pi: ExtensionAPI, ctx: unknown, ownership: DispatcherOwnership): boolean {
  const identity = dispatcherContextIdentity(ctx);
  if (!identity
    || identity.owner !== ownership.owner
    || identity.rootIdentity !== ownership.rootIdentity
    || identity.cwd !== ownership.cwd
    || (identity.sessionFile ?? null) !== (ownership.sessionFile ?? null)
    || (identity.sessionGeneration ?? null) !== (ownership.sessionGeneration ?? null)) return false;
  const manager = authoritativeSessionManager(ctx);
  if (ownership.sessionManager && manager !== ownership.sessionManager) return false;
  const managerGeneration = dispatcherManagerGeneration(pi, ctx);
  // Current host managers are stable across hook contexts and therefore carry
  // the generation token. A context whose manager was not observed at start
  // cannot be trusted to wake or stop this dispatcher, even when its session
  // file happens to match.
  return managerGeneration !== undefined && managerGeneration === ownership.generation;
}

function withDispatcherIdentityGuard(
  runtimeAccess: CtoRuntimeAccessFacade,
  assertIdentityLive: () => void,
): CtoRuntimeAccessFacade {
  return createCtoRuntimeAccessGuardedView(runtimeAccess, assertIdentityLive);
}

const MAX_PENDING_CTO_WAKES = 128;
const MAX_PENDING_CTO_WAKE_BYTES = 64 * 1024;
const MAX_RESEARCH_AUTHORIZATIONS = 128;
const RESEARCH_AUTHORIZATION_TTL_MS = 120_000;
const MAX_RESEARCH_AUTHORIZED_PAYLOAD_BYTES = 96_000;

interface ResearchRequestAuthorization extends DispatcherOwnership {
  readonly token: string;
  readonly digest: string;
  readonly payload: string;
  readonly expiresAt: number;
}
const researchAuthorizationsByPi = new WeakMap<object, Map<string, ResearchRequestAuthorization>>();

function researchPayloadDigest(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function issueResearchRequestAuthorization(pi: ExtensionAPI, ctx: unknown, cwd: string, payload: string): string | null {
  if (typeof payload !== "string" || payload.length === 0 || Buffer.byteLength(payload, "utf8") > MAX_RESEARCH_AUTHORIZED_PAYLOAD_BYTES) return null;
  const identity = dispatcherContextIdentity(ctx);
  const current = dispatcherCurrentOwnershipByPi.get(pi as object);
  if (!identity || !current
    || identity.owner !== current.owner
    || identity.rootIdentity !== current.rootIdentity
    || identity.cwd !== current.cwd
    || (identity.sessionFile ?? null) !== (current.sessionFile ?? null)
    || !dispatcherIdentityMatches(pi, ctx, current)) return null;
  const token = randomBytes(32).toString("base64url");
  const authorization: ResearchRequestAuthorization = {
    token,
    digest: researchPayloadDigest(payload),
    payload,
    owner: current.owner,
    rootIdentity: current.rootIdentity,
    cwd: current.cwd,
    generation: current.generation,
    sessionFile: current.sessionFile,
    expiresAt: Date.now() + RESEARCH_AUTHORIZATION_TTL_MS,
  };
  const authorizations = researchAuthorizationsByPi.get(pi as object) ?? new Map<string, ResearchRequestAuthorization>();
  authorizations.set(token, authorization);
  while (authorizations.size > MAX_RESEARCH_AUTHORIZATIONS) {
    const oldest = authorizations.keys().next().value;
    if (typeof oldest !== "string") break;
    authorizations.delete(oldest);
  }
  researchAuthorizationsByPi.set(pi as object, authorizations);
  return buildResearchRequestAuthorizationEnvelope(token, authorization.digest, payload);
}

function consumeResearchRequestAuthorization(pi: ExtensionAPI, ctx: unknown, prompt: string): string | null {
  const parsed = extractResearchRequestAuthorizationEnvelope(prompt);
  if (!parsed) return null;
  const authorizations = researchAuthorizationsByPi.get(pi as object);
  const authorization = authorizations?.get(parsed.token);
  // Consume before checking the mutable context: every attempt is one-shot,
  // including a stale/forged attempt, so replay cannot race a rebind.
  authorizations?.delete(parsed.token);
  if (!authorization || authorization.expiresAt <= Date.now()) return null;
  if (authorization.digest !== parsed.digest
    || authorization.payload !== parsed.payload
    || researchPayloadDigest(parsed.payload) !== parsed.digest) return null;
  const identity = dispatcherContextIdentity(ctx);
  if (!identity
    || identity.owner !== authorization.owner
    || identity.rootIdentity !== authorization.rootIdentity
    || identity.cwd !== authorization.cwd
    || (identity.sessionFile ?? null) !== (authorization.sessionFile ?? null)
    || !dispatcherIdentityMatches(pi, ctx, authorization)) return null;
  return authorization.payload;
}


function closePendingCtoWake(wake: PendingCtoWake): void {
  if (!wake.completion.settled) {
    wake.completion.settled = true;
    wake.completion.reject(Object.assign(new Error("pending CTO wake was revoked before provider hydration"), { code: "activation_revoked" }));
  }
  void wake.pin.closeAsync().catch(() => undefined);
}

function settlePendingCtoWake(wake: PendingCtoWake, error?: unknown): void {
  if (wake.completion.settled) return;
  wake.completion.settled = true;
  if (error === undefined) wake.completion.resolve();
  else wake.completion.reject(error);
}

function newPendingCtoWakeCompletion(): PendingCtoWake["completion"] & { readonly promise: Promise<void> } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  // A sendUserMessage failure can discard the pending entry before its
  // callback reaches `await completion.promise`; consume that rejection while
  // retaining the same promise for the normal provider-boundary path.
  void promise.catch(() => undefined);
  const completion = { settled: false, resolve, reject };
  return Object.assign(completion, { promise });
}

function currentCtoRunRevision(runtimeAccess: CtoRuntimeAccessFacade, runId: string): number | null {
  try {
    runtimeAccess.assertLive();
    const active = runtimeAccess.findActiveRun();
    if (!active || active.runId !== runId) return null;
    const revision = active.state.state_revision;
    return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  } catch {
    return null;
  }
}

function currentPendingCtoWakeRevision(wake: PendingCtoWake): number | null {
  return currentCtoRunRevision(wake.runtimeAccess, wake.runId);
}

function forgetPendingCtoWake(wakes: Map<string, PendingCtoWake>, token: string): void {
  const wake = wakes.get(token);
  if (!wake) return;
  wakes.delete(token);
  closePendingCtoWake(wake);
}

function rememberPendingCtoWake(wakes: Map<string, PendingCtoWake>, wake: PendingCtoWake): void {
  const previous = wakes.get(wake.token);
  if (previous) closePendingCtoWake(previous);
  wakes.set(wake.token, wake);
  while (wakes.size > MAX_PENDING_CTO_WAKES) {
    const oldest = wakes.keys().next().value;
    if (typeof oldest !== "string" || oldest === wake.token) break;
    forgetPendingCtoWake(wakes, oldest);
  }
}

function pendingCtoWakeEffectFileName(runId: string, id: string): string {
  return `${createHash("sha256").update(`${runId}/${id}`).digest("hex")}.json`;
}

function pendingCtoWakePath(wake: PendingCtoWake): string {
  if (wake.kind === "inbox") {
    return join(inboxDir(wake.runId, wake.cwd), inboxMessageFileName(wake.id));
  }
  return join(wake.cwd, ".work-state", "cto", wake.runId, "wake-effects", pendingCtoWakeEffectFileName(wake.runId, wake.id));
}

function readPendingCtoWakeText(wake: PendingCtoWake): string | null {
  const pin = wake.pin;
  if (!pin.isStable()) return null;
  let relativePath: string | null;
  try { relativePath = pin.relativePath(pendingCtoWakePath(wake)); } catch { return null; }
  if (!relativePath) return null;
  try {
    const entry = pin.pathEntryInfo(relativePath);
    if (!entry || entry.kind !== "file") return null;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(pin.readFile(relativePath, { maxBytes: MAX_PENDING_CTO_WAKE_BYTES }).bytes);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (wake.kind === "inbox") {
      const task: InboxTask = {
        id: typeof record.id === "string" ? record.id : "",
        text: typeof record.text === "string" ? record.text : "",
        at: typeof record.at === "string" ? record.at : "",
        runId: typeof record.runId === "string" ? record.runId : "",
        ...(typeof record.by === "string" ? { by: record.by } : {}),
        ...(typeof record.chatId === "string" ? { chatId: record.chatId } : {}),
        ...(typeof record.userId === "string" ? { userId: record.userId } : {}),
        ...(typeof record.messageId === "number" ? { messageId: record.messageId } : {}),
      };
      if (task.id !== wake.id || task.runId !== wake.runId || ctoInboxWakeDigest(task) !== wake.digest) return null;
      if (!task.text || !pin.isStable()) return null;
      return task.text;
    }
    const answer = record.answer;
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
    const answerRecord = answer as Record<string, unknown>;
    if (answerRecord.id !== wake.id || answerRecord.run_id !== wake.runId || typeof answerRecord.answer !== "string") return null;
    const value = { id: answerRecord.id, run_id: answerRecord.run_id, answer: answerRecord.answer };
    if (ctoAnswerWakeDigest(value) !== wake.digest || !pin.isStable()) return null;
    return value.answer;
  } catch {
    return null;
  }
}

type WakePayloadTransform = { readonly value: unknown; readonly changed: boolean };

async function transformCtoWakePayload(
  value: unknown,
  userRole: boolean,
  resolveReference: (reference: ParsedCtoWakeReference) => Promise<string | null | undefined>,
): Promise<WakePayloadTransform> {
  if (typeof value === "string") {
    if (!userRole) return { value, changed: false };
    const references = parseCtoWakeReferences(value);
    if (references.length === 0) return { value, changed: false };
    let replaced = value;
    let changed = false;
    for (const reference of references) {
      const replacement = await resolveReference(reference);
      if (replacement === undefined || replacement === null) continue;
      replaced = replaced.split(reference.token).join(replacement);
      changed = true;
    }
    return { value: replaced, changed };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const transformed: unknown[] = [];
    for (const item of value) {
      const result = await transformCtoWakePayload(item, userRole, resolveReference);
      transformed.push(result.value);
      changed ||= result.changed;
    }
    return { value: changed ? transformed : value, changed };
  }
  if (!isPlainContextObject(value)) return { value, changed: false };
  const role = userRole || value.role === "user";
  let changed = false;
  const transformed: Record<string, unknown> = { ...value };
  for (const [key, item] of Object.entries(value)) {
    const result = await transformCtoWakePayload(item, role, resolveReference);
    transformed[key] = result.value;
    changed ||= result.changed;
  }
  return { value: changed ? transformed : value, changed };
}

/**
 * Task subagents run with `hasUI: false` and load the same extension. Only the
 * interactive main session may own the product messenger dispatcher; otherwise
 * every lead/worker creates another getUpdates consumer with its own offset.
 * Unknown contexts are treated as main for compatibility with older OMP/test
 * runtimes that did not expose `hasUI` on session_start.
 */
export function isMainSessionContext(ctx: unknown): boolean {
	if (!ctx || typeof ctx !== "object") return true;
	if (!("hasUI" in ctx)) return true;
	return ctx.hasUI !== false;
}
export const FULLSTACK_BUNDLE_ID = "@andvl1/omp-workflows-fullstack";
export const FULLSTACK_ACTIVATION_MARKER = "omp-fullstack";

export function fullstackOwnerForCwd(cwd: string): WorkflowOwnerIdentity {
  const root = resolve(cwd);
  return {
    owner_id: FULLSTACK_BUNDLE_ID,
    bundle_id: FULLSTACK_BUNDLE_ID,
    owner_kind: "fullstack",
    activation_marker: FULLSTACK_ACTIVATION_MARKER,
    host_range: ">=17 <19",
    activation: {
      marker_id: FULLSTACK_ACTIVATION_MARKER,
      required: [{ path: FULLSTACK_ACTIVATION_MARKER_PATH, kind: "file", sha256: FULLSTACK_ACTIVATION_MARKER_SHA256 }],
    },
    provenance: {
      package: FULLSTACK_BUNDLE_ID,
      entrypoint: "dist/index.js",
      cwd: root,
      config_path: join(root, ".omp", "team.config.json"),
    },
  };

}

// Core privately loads and reserves the shipped native specification profiles;
// this bundle contributes only the native provider and recognizers below.
const nativeConstitutionProvider = Object.freeze({
  provider_id: NATIVE_CONSTITUTION_PROVIDER_ID,
  discover: () => [],
  template: NATIVE_CONSTITUTION_TEMPLATE,
});

const FULLSTACK_REGISTRY_FAMILIES = [
  "runtime_config",
  "workflow_profiles",
  "workflow_tools",
  "constitution_providers",
  "format_recognizers",
  "constitution_gate",
] as const;

/** Register the shipped native specification assets under one authenticated
 * registry transaction. The token is mandatory: no process-global ownerless
 * writes are permitted, and repeated roots may only contribute the exact same
 * descriptors through the core registry idempotence/fingerprint checks. */
export function registerNativeSpecificationAssets(registrationToken: RegistryRegistrationToken): void {
  const templates = resolveSpecificationTemplateSet({ template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS });
  if (!templates.ok) {
    throw new Error("shipped specification templates failed to resolve: " + templates.error);
  }
  registerConstitutionProvider(registrationToken, speckitConstitutionProvider);
  registerConstitutionProvider(registrationToken, nativeConstitutionProvider);
  for (const recognizer of specificationRecognizers()) {
    registerFormatRecognizer(registrationToken, recognizer);
  }
}

/** Fullstack keeps only bundle-specific adaptation; core owns tool behavior. */
export function registerWorkflowTools(pi: ExtensionAPI, registrationToken: RegistryRegistrationToken): void {
  const adapter = createWorkflowToolAdapter({
    resolveCwd: resolveSessionCwd,
    owner: fullstackOwnerForCwd,
    registrationToken,
    beforeBegin: cwd => waitForFullstackAgentMappings(cwd),
    mappingSummary: summarizeAgentMapping,
  });
  adapter.register(pi);
  registerConstitutionTools(pi, {
    resolveCwd: resolveSessionCwd,
    owner: fullstackOwnerForCwd,
    registrationToken,
  });
  registerCtoTools(pi, {
    resolveCwd: resolveSessionCwd,
    owner: fullstackOwnerForCwd,
    registrationToken,
  });
}

const CTO_WAKE_REFERENCE_SCHEMA = 1;
const CTO_WAKE_REFERENCE_RE = /\[CTO_WAKE_REF schema=1 kind=(inbox|answer) run=([A-Za-z0-9_-]{0,1024}) id=([A-Za-z0-9_-]{1,1024}) digest=([a-f0-9]{64})\]/gu;

type CtoWakeReferenceKind = "inbox" | "answer";
interface ParsedCtoWakeReference {
  readonly token: string;
  readonly kind: CtoWakeReferenceKind;
  readonly runId: string;
  readonly id: string;
  readonly digest: string;
}

function encodeCtoWakeField(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCtoWakeField(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded.length > 0 && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function ctoWakeDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ctoInboxWakeDigest(task: InboxTask): string {
  return ctoWakeDigest({
    kind: "inbox",
    id: task.id,
    run_id: task.runId ?? null,
    text: task.text,
    at: task.at,
    by: task.by ?? null,
    chatId: task.chatId ?? null,
    userId: task.userId ?? null,
    messageId: task.messageId ?? null,
  });
}

function ctoAnswerWakeDigest(answer: { id: string; run_id: string; answer: string }): string {
  return ctoWakeDigest({ kind: "answer", id: answer.id, run_id: answer.run_id, answer: answer.answer });
}

function ctoWakeReference(kind: CtoWakeReferenceKind, runId: string, id: string, digest: string): string {
  return `[CTO_WAKE_REF schema=${CTO_WAKE_REFERENCE_SCHEMA} kind=${kind} run=${encodeCtoWakeField(runId)} id=${encodeCtoWakeField(id)} digest=${digest}]`;
}

function parseCtoWakeReferences(text: string): ParsedCtoWakeReference[] {
  const references: ParsedCtoWakeReference[] = [];
  for (const match of text.matchAll(CTO_WAKE_REFERENCE_RE)) {
    const runId = decodeCtoWakeField(match[2] ?? "");
    const id = decodeCtoWakeField(match[3] ?? "");
    const digest = match[4] ?? "";
    if (!runId || !id || !/^[a-f0-9]{64}$/u.test(digest)) continue;
    references.push({ token: match[0], kind: match[1] as CtoWakeReferenceKind, runId, id, digest });
  }
  return references;
}

export function buildCtoInboxWakeMessage(task: InboxTask): string {
  const reference = ctoWakeReference("inbox", task.runId ?? "", task.id, ctoInboxWakeDigest(task));
  return [
    "[CTO-INBOX] Authenticated messenger event received.",
    "The actual inbound record remains in the authenticated durable inbox and is resolved only at the provider boundary.",
    reference,
  ].join("\n");
}

export function buildCtoAnswerWakeMessage(answer: { id: string; run_id: string; answer: string }): string {
  const reference = ctoWakeReference("answer", answer.run_id, answer.id, ctoAnswerWakeDigest(answer));
  return [
    "[CTO-ANSWER] Authenticated messenger answer event received.",
    "The actual answer remains in the authenticated durable wake record and is resolved only at the provider boundary.",
    reference,
  ].join("\n");
}


type FullstackActivationSuccess = Extract<WorkflowActivationResult, { readonly ok: true }>;
interface FullstackActivationLease {
  readonly activation: FullstackActivationSuccess;
}
type FullstackActivationLiveGuard = ReturnType<typeof createRegistryRegistrationLiveGuard>;
interface FullstackActivation {
  readonly context: RegistryRegistrationContext;
  readonly runtimeAuthority: CtoRuntimeAccessSession;
  readonly runtimeAccess: CtoRuntimeAccessFacade;
  readonly sessionManager: object;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly sessionBasename?: string;
  readonly generation?: string | number;
  readonly sessionBindingController: TeamSessionBindingController;
  readonly binding: TeamSessionRuntimeBinding;
  readonly proofAuthority: CtoRuntimeProofAuthority;
  /** Private project-service capability for intentional cross-run dispatcher mutations. */
  readonly serviceAuthority: CtoRuntimeServiceMutationAuthority;
  readonly liveGuard: FullstackActivationLiveGuard;
  readonly leases: readonly FullstackActivationLease[];
}
const fullstackActivations = new WeakMap<object, Set<string>>();
const fullstackActivationContexts = new WeakMap<object, Map<string, RegistryRegistrationContext>>();
const fullstackActivationRecords = new WeakMap<object, Map<string, FullstackActivation>>();
/** The current session root for one host instance. A session move must revoke
 * the previous root before retaining a new activation, even when both roots
 * happen to use the same extension API object. */
const fullstackActiveRootByPi = new WeakMap<object, string>();
interface FullstackLifecycleAdmission {
  readonly sessionManager: object;
  readonly owner: string;
  readonly rootIdentity: string;
  readonly cwd: string;
  readonly sessionGeneration?: string | number;
}
const fullstackLifecycleAdmissionByPi = new WeakMap<object, FullstackLifecycleAdmission>();
/** Dispatcher stops started by root migration must settle before the next
 * main-session start claims a moved/replaced project path. */
const pendingDispatcherStopsByPi = new WeakMap<object, Set<Promise<void>>>();
type LectureMountState = "active" | "failed";
/** Host lecture tools are mounted once per pi; execution resolves its live root per call. */
const fullstackLectureMounts = new WeakMap<object, LectureMountState>();
interface RuntimeAccessSlot {
  readonly sessionId: string;
  readonly lexicalRoot: string;
  readonly authority: CtoRuntimeAccessSession;
  readonly access: CtoRuntimeAccessFacade;
}
const fullstackRuntimeAccesses = new WeakMap<object, Map<string, RuntimeAccessSlot>>();
const runtimeAccessByRoot = new Map<string, CtoRuntimeAccessFacade>();
const fullstackRuntimeAccessProviderUnregisters = new WeakMap<object, () => void>();
const fullstackGateInstallations = new Set<string>();

function closeRuntimeAccessSlot(root: string, slot: RuntimeAccessSlot): void {
  try { slot.access.close(); } catch { /* teardown is best-effort; identity maps are still fenced */ }
  // The canonical physical root is authoritative. Remove every lexical alias
  // that still points at this exact facade; alias spelling is display-only and
  // must never decide whether a live capability is closed.
  for (const [key, access] of runtimeAccessByRoot) {
    if (access === slot.access) runtimeAccessByRoot.delete(key);
  }
}

function evictRuntimeAccessSlot(pi: ExtensionAPI, root: string, expected?: RuntimeAccessSlot): void {
  const accesses = fullstackRuntimeAccesses.get(pi as object);
  const slot = accesses?.get(root);
  if (slot && (!expected || slot === expected)) {
    closeRuntimeAccessSlot(root, slot);
    accesses?.delete(root);
  } else if (!slot) {
    const providerAccess = runtimeAccessByRoot.get(root);
    if (!expected || providerAccess === expected.access) runtimeAccessByRoot.delete(root);
  }
  if (accesses && accesses.size === 0) fullstackRuntimeAccesses.delete(pi as object);
}

function evictAllRuntimeAccessSlots(pi: ExtensionAPI): void {
  const accesses = fullstackRuntimeAccesses.get(pi as object);
  if (!accesses) return;
  for (const [root, slot] of accesses) closeRuntimeAccessSlot(root, slot);
  fullstackRuntimeAccesses.delete(pi as object);
}

function evictFullstackRoot(pi: ExtensionAPI, root: string, expected?: FullstackActivation, expectedRuntimeSlot?: RuntimeAccessSlot): void {
  const activationRecords = fullstackActivationRecords.get(pi as object);
  const record = activationRecords?.get(root);
  if (expected && record !== expected) return;
  const currentRuntimeSlot = fullstackRuntimeAccesses.get(pi as object)?.get(root);
  if (expectedRuntimeSlot && currentRuntimeSlot !== expectedRuntimeSlot) return;
  // Capture the exact runtime slot before teardown. The binding must be
  // released while its runtime authority is still live; closing the slot first
  // makes releaseExactBinding fail closed and leaks the host binding.
  const expectedSlot = expected ? fullstackRuntimeAccesses.get(pi as object)?.get(root) : undefined;
  const dispatchersToStop = [...dispatcherStopsByRootIdentity.entries()]
    .filter(([, slot]) => slot.cwd === root);
  for (const [identity, slot] of dispatchersToStop) {
    const stopPromise = Promise.resolve()
      .then(() => slot.stop())
      .catch(() => undefined)
      .then(() => undefined);
    const pending = pendingDispatcherStopsByPi.get(pi as object) ?? new Set<Promise<void>>();
    pending.add(stopPromise);
    pendingDispatcherStopsByPi.set(pi as object, pending);
    void stopPromise.finally(() => {
      pending.delete(stopPromise);
      if (pending.size === 0) pendingDispatcherStopsByPi.delete(pi as object);
      if (dispatcherStopsByRootIdentity.get(identity) === slot) dispatcherStopsByRootIdentity.delete(identity);
    });
  }
  if (record) {
    record.sessionBindingController.release(record.binding);
    evictRuntimeAccessSlot(pi, root, expectedSlot);
    try { record.runtimeAccess.close(); } catch { /* teardown is best-effort */ }
    revokeCtoRuntimeProofAuthority(record.proofAuthority);
    revokeCtoRuntimeServiceMutationAuthority(record.serviceAuthority);
    for (const lease of record.leases) {
      try { closeWorkflowActivation(lease.activation); } catch { /* teardown is best-effort; context fencing still applies */ }
    }
    activationRecords?.delete(root);
  }
  if (activationRecords && activationRecords.size === 0) fullstackActivationRecords.delete(pi as object);
  const activations = fullstackActivations.get(pi as object);
  activations?.delete(root);
  if (activations && activations.size === 0) fullstackActivations.delete(pi as object);
  const contexts = fullstackActivationContexts.get(pi as object);
  contexts?.delete(root);
  if (contexts && contexts.size === 0) fullstackActivationContexts.delete(pi as object);
  if (fullstackActiveRootByPi.get(pi as object) === root) fullstackActiveRootByPi.delete(pi as object);
  for (const key of fullstackGateInstallations) {
    if (key.startsWith(root + "\0")) fullstackGateInstallations.delete(key);
  }
}

async function awaitPendingDispatcherStops(pi: ExtensionAPI): Promise<void> {
  const pending = pendingDispatcherStopsByPi.get(pi as object);
  if (!pending || pending.size === 0) return;
  await Promise.all([...pending]);
}

function runtimeAccessForSession(pi: ExtensionAPI, cwd: string, sessionId: string): CtoRuntimeAccessFacade | null {
  const pinnedRoot = openSessionRoot(cwd);
  if (!pinnedRoot) return null;
  try {
    if (!pinnedRoot.isStable()) return null;
    const root = pinnedRoot.canonical_root;
    const accesses = fullstackRuntimeAccesses.get(pi as object) ?? new Map<string, RuntimeAccessSlot>();
    const existing = accesses.get(root);
    if (existing?.sessionId === sessionId) {
      try {
        existing.access.assertLive();
        return existing.access;
      } catch (error) {
        // The retained activation was already revalidated by the session-start
        // path. Revoke only this stale capability, then reopen from that fresh
        // context without recursively mounting host tools or gates.
        evictRuntimeAccessSlot(pi, root, existing);
        const afterEviction = fullstackRuntimeAccesses.get(pi as object)?.get(root);
        if (afterEviction && afterEviction !== existing) {
          // A replacement generation won the slot while this stale capability
          // was being fenced. Never close or overwrite that newer capability.
          return afterEviction.sessionId === sessionId ? afterEviction.access : null;
        }
        const refreshedContext = fullstackActivationContexts.get(pi as object)?.get(root);
        if (!refreshedContext) {
          evictFullstackRoot(pi, root, fullstackActivationRecords.get(pi as object)?.get(root));
          console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: "activation_revoked", error: String(error instanceof Error ? error.message : error) }));
          return null;
        }
        const refreshedAuthority = ctoRuntimeSessionAuthorityForContext(refreshedContext);
        if (!refreshedAuthority) {
          evictFullstackRoot(pi, root, fullstackActivationRecords.get(pi as object)?.get(root));
          return null;
        }
        const reopened = openCtoRuntimeAccess(refreshedContext, refreshedAuthority, root);
        if (!reopened.ok) {
          evictFullstackRoot(pi, root, fullstackActivationRecords.get(pi as object)?.get(root));
          console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: reopened.code, error: reopened.error }));
          return null;
        }
        const reopenedSlot: RuntimeAccessSlot = { sessionId, lexicalRoot: pinnedRoot.lexical_root, authority: refreshedAuthority, access: reopened.access };
        const reopenedAccesses = fullstackRuntimeAccesses.get(pi as object) ?? new Map<string, RuntimeAccessSlot>();
        const replacement = reopenedAccesses.get(root);
        if (replacement) {
          // Do not replace a slot installed after the stale slot was evicted;
          // the candidate facade is unreferenced and can be closed directly.
          closeRuntimeAccessSlot(root, reopenedSlot);
          return replacement.sessionId === sessionId ? replacement.access : null;
        }
        reopenedAccesses.set(root, reopenedSlot);
        fullstackRuntimeAccesses.set(pi as object, reopenedAccesses);
        runtimeAccessByRoot.set(root, reopened.access);
        runtimeAccessByRoot.set(pinnedRoot.lexical_root, reopened.access);
        return reopened.access;
      }
    }
    if (existing) {
      // A stale caller must never evict, reopen, or relabel a newer session's
      // slot. Only the exact requested session may repair its stale facade.
      if (existing.sessionId !== sessionId) return null;
      evictRuntimeAccessSlot(pi, root, existing);
      const replacement = fullstackRuntimeAccesses.get(pi as object)?.get(root);
      if (replacement) return replacement.sessionId === sessionId ? replacement.access : null;
    }
    const record = fullstackActivationRecords.get(pi as object)?.get(root);
    if (!record || record.sessionId !== sessionId) return null;
    const context = record.context;
    const authority = ctoRuntimeSessionAuthorityForContext(context);
    if (!authority || authority !== record.runtimeAuthority) return null;
    const opened = openCtoRuntimeAccess(context, authority, root);
    if (!opened.ok) {
      evictRuntimeAccessSlot(pi, root);
      if (opened.code === "activation_revoked") evictFullstackRoot(pi, root);
      console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: opened.code, error: opened.error }));
      return null;
    }
    const slot: RuntimeAccessSlot = { sessionId, lexicalRoot: pinnedRoot.lexical_root, authority, access: opened.access };
    const replacement = fullstackRuntimeAccesses.get(pi as object)?.get(root);
    if (replacement) {
      closeRuntimeAccessSlot(root, slot);
      return replacement.sessionId === sessionId ? replacement.access : null;
    }
    accesses.set(root, slot);
    fullstackRuntimeAccesses.set(pi as object, accesses);
    runtimeAccessByRoot.set(root, opened.access);
    runtimeAccessByRoot.set(pinnedRoot.lexical_root, opened.access);
    return opened.access;
  } finally {
    pinnedRoot.close();
  }
}

function runtimeAccessForCwd(cwd: string): CtoRuntimeAccessFacade | undefined {
  const direct = runtimeAccessByRoot.get(cwd);
  if (direct) return direct;
  const pinnedRoot = openSessionRoot(cwd);
  if (!pinnedRoot) return undefined;
  try { return runtimeAccessByRoot.get(pinnedRoot.canonical_root); } finally { pinnedRoot.close(); }
}

/** Resolve only the exact activation-owned proof authority for one live host context. */
function proofAuthorityForCwd(pi: ExtensionAPI, cwd: string, ctx?: unknown): CtoRuntimeProofAuthority | undefined {
  const pinnedRoot = openSessionRoot(cwd);
  if (!pinnedRoot) return undefined;
  try {
    const root = pinnedRoot.canonical_root;
    const record = fullstackActivationRecords.get(pi as object)?.get(root);
    if (!record) return undefined;
    record.liveGuard();
    if (ctx !== undefined) {
      const binding = record.sessionBindingController.current(ctx);
      if (!binding || binding.registryContext !== record.context || binding.runtimeAuthority !== record.runtimeAuthority || binding.runtimeAccess !== record.runtimeAccess) return undefined;
      if (binding.canonicalRoot !== root || binding.rootDev !== pinnedRoot.dev || binding.rootIno !== pinnedRoot.ino) return undefined;
    }
    return record.proofAuthority;
  } catch {
    return undefined;
  } finally {
    pinnedRoot.close();
  }
}

/** Resolve only the current fullstack owner genuine live runtime facade. */
function fullstackRuntimeAccessProvider(pi: ExtensionAPI, requestedRoot: string, requestedSessionId?: string): CtoRuntimeAccessFacade | null {
  let pinnedRoot: PinnedProjectRoot | null;
  try { pinnedRoot = openSessionRoot(requestedRoot); } catch { return null; }
  if (!pinnedRoot) return null;
  try {
    if (!pinnedRoot.isStable() || pinnedRoot.canonical_root !== requestedRoot) return null;
    const root = pinnedRoot.canonical_root;
    const slot = fullstackRuntimeAccesses.get(pi as object)?.get(root);
    if (!slot) return null;
    if (requestedSessionId !== undefined && requestedSessionId !== slot.sessionId) return null;
    const ownership = dispatcherCurrentOwnershipByPi.get(pi as object);
    if (ownership && (ownership.cwd !== root || ownership.owner !== slot.sessionId)) return null;
    const access = runtimeAccessByRoot.get(root);
    if (!access || access !== slot.access) return null;
    const activation = fullstackActivationRecords.get(pi as object)?.get(root);
    if (!activation) return null;
    activation.liveGuard();
    access.assertProjectRoot(root);
    access.assertLive();
    if (!pinnedRoot.isStable()) return null;
    return access;
  } catch {
    return null;
  } finally {
    pinnedRoot.close();
  }
}

function registerFullstackRuntimeAccessProvider(pi: ExtensionAPI): void {
  if (fullstackRuntimeAccessProviderUnregisters.has(pi as object)) return;
  const unregister = registerCtoRuntimeAccessProvider((root, sessionId) => fullstackRuntimeAccessProvider(pi, root, sessionId));
  fullstackRuntimeAccessProviderUnregisters.set(pi as object, unregister);
}

function unregisterFullstackRuntimeAccessProvider(pi: ExtensionAPI): void {
  const unregister = fullstackRuntimeAccessProviderUnregisters.get(pi as object);
  if (!unregister) return;
  fullstackRuntimeAccessProviderUnregisters.delete(pi as object);
  try { unregister(); } catch { /* provider disposal is best-effort and idempotent */ }
}

function currentFullstackLiveRoot(
  pi: ExtensionAPI,
  ctx: unknown,
  requestedCwd: string,
): string | null {
  const authoritativeCwd = resolveSessionCwd(ctx);
  if (!authoritativeCwd || authoritativeCwd !== requestedCwd) return null;
  let pinnedRoot: PinnedProjectRoot | null;
  try { pinnedRoot = openSessionRoot(authoritativeCwd); } catch { return null; }
  if (!pinnedRoot) return null;
  try {
    if (!pinnedRoot.isStable()) return null;
    const root = pinnedRoot.canonical_root;
    const activations = fullstackActivations.get(pi as object);
    const contexts = fullstackActivationContexts.get(pi as object);
    const record = fullstackActivationRecords.get(pi as object)?.get(root);
    if (!activations?.has(root) || !contexts?.has(root) || !record) return null;
    try {
      record.liveGuard();
    } catch {
      evictFullstackRoot(pi, root, record);
      return null;
    }
    if (!pinnedRoot.isStable()) return null;
    return root;
  } finally {
    pinnedRoot.close();
  }
}

function ensureFullstackLiveRoot(
  pi: ExtensionAPI,
  ctx: unknown,
  requestedCwd: string,
  requireMain = true,
): string | null {
  if (requireMain && !isMainSessionContext(ctx)) return null;
  const authoritativeCwd = resolveSessionCwd(ctx);
  if (!authoritativeCwd || authoritativeCwd !== requestedCwd) return null;
  let pinnedRoot: PinnedProjectRoot | null;
  try { pinnedRoot = openSessionRoot(authoritativeCwd); } catch { return null; }
  if (!pinnedRoot) return null;
  try {
    if (!pinnedRoot.isStable()) return null;
    const canonicalCwd = pinnedRoot.canonical_root;
    if (!ensureFullstackActivation(pi, canonicalCwd, ctx)) return null;
    if (!pinnedRoot.isStable()) return null;
    return canonicalCwd;
  } finally {
    pinnedRoot.close();
  }
}

function ensureLectureLiveActivation(
  pi: ExtensionAPI,
  ctx: unknown,
  requestedCwd: string,
): { cwd: string; runtimeAccess: CtoRuntimeAccessFacade } | null {
  const liveCwd = ensureFullstackLiveRoot(pi, ctx, requestedCwd, true);
  if (!liveCwd) return null;
  const authoritativeCwd = liveCwd;
  const sessionId = sessionIdFromContext(undefined, ctx);
  if (!sessionId) return null;
  let pinnedRoot: PinnedProjectRoot | null;
  try {
    pinnedRoot = openSessionRoot(authoritativeCwd);
  } catch {
    return null;
  }
  if (!pinnedRoot) return null;
  try {
    if (!pinnedRoot.isStable()) return null;
    const canonicalCwd = pinnedRoot.canonical_root;
    if (canonicalCwd !== liveCwd || !ensureFullstackActivation(pi, canonicalCwd, ctx)) return null;
    const runtimeAccess = runtimeAccessForSession(pi, canonicalCwd, sessionId);
    if (!runtimeAccess) return null;
    try {
      runtimeAccess.assertLive();
    } catch {
      return null;
    }
    return { cwd: canonicalCwd, runtimeAccess };
  } finally {
    pinnedRoot.close();
  }
}

/** Mount the fullstack engine only after one root-authenticated transaction. */
function initialSessionIdentityForContext(ctx: unknown): { sessionManager: object; sessionId: string; sessionFile?: string; sessionBasename?: string; generation?: string | number } | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const manager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (!manager || typeof manager !== "object") return undefined;
  try {
    const get = (name: string): unknown => {
      const fn = (manager as Record<string, unknown>)[name];
      return typeof fn === "function" ? fn.call(manager) : undefined;
    };
    const sessionId = get("getSessionId");
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    const file = get("getSessionFile");
    const generation = get("getSessionGeneration");
    return Object.freeze({
      sessionManager: manager,
      sessionId,
      ...(typeof file === "string" && file.length > 0 ? { sessionFile: file, sessionBasename: file.split(/[\\/]/u).at(-1) } : {}),
      ...(typeof generation === "string" || typeof generation === "number" ? { generation } : {}),
    });
  } catch { return undefined; }
}

function ensureFullstackActivation(pi: ExtensionAPI, cwd: string, initialSessionContext?: unknown): boolean {
  registerFullstackRuntimeAccessProvider(pi);
  const pinnedRoot = openSessionRoot(cwd);
  if (!pinnedRoot) return false;
  const root = pinnedRoot.canonical_root;
  const activeRoot = fullstackActiveRootByPi.get(pi as object);
  if (activeRoot && activeRoot !== root) {
    const admission = fullstackLifecycleAdmissionByPi.get(pi as object);
    const identity = initialSessionContext === undefined ? undefined : dispatcherContextIdentity(initialSessionContext);
    if (!admission || !identity || identity.sessionManager !== admission.sessionManager || identity.owner !== admission.owner
      || identity.rootIdentity !== admission.rootIdentity || identity.cwd !== admission.cwd
      || (identity.sessionGeneration ?? null) !== (admission.sessionGeneration ?? null)) {
      pinnedRoot.close();
      return false;
    }
    evictFullstackRoot(pi, activeRoot);
  }
  let freshRetryAvailable = true;
  while (true) {
    const currentActivations = fullstackActivations.get(pi as object);
    const currentContexts = fullstackActivationContexts.get(pi as object);
    const currentRecord = fullstackActivationRecords.get(pi as object)?.get(root);
    if (!currentActivations?.has(root) || !currentContexts?.has(root) || !currentRecord) break;
    let ownedRecord = currentRecord;
    let transientBinding: TeamSessionRuntimeBinding | undefined;
    try {
      currentRecord.liveGuard();
      let binding: TeamSessionRuntimeBinding | null = null;
      if (initialSessionContext !== undefined) {
        binding = currentRecord.sessionBindingController.bind(initialSessionContext);
        if (!binding) { pinnedRoot.close(); return false; }
        transientBinding = binding;
        const currentBinding = currentRecord.sessionBindingController.current(initialSessionContext);
        if (!binding || !currentBinding || binding.registryContext !== currentBinding.registryContext
          || binding.runtimeAuthority !== currentBinding.runtimeAuthority
          || binding.runtimeAccess !== currentBinding.runtimeAccess) throw new Error("session binding controller rejected the current host context");
        const currentMap = fullstackActivationRecords.get(pi as object);
        const currentContexts = fullstackActivationContexts.get(pi as object);
        if (currentMap?.get(root) !== currentRecord || currentContexts?.get(root) !== currentRecord.context) throw new Error("activation record changed during session rebinding");
        const oldProofAuthority = currentRecord.proofAuthority;
        const oldServiceAuthority = currentRecord.serviceAuthority;
        const nextProofAuthority = openCtoRuntimeProofAuthority(binding.registryContext, pinnedRoot);
        if (!nextProofAuthority) throw new Error("runtime proof authority is unavailable after session rebinding");
        const nextServiceAuthority = openCtoRuntimeServiceMutationAuthority(binding.registryContext, pinnedRoot);
        if (!nextServiceAuthority) {
          revokeCtoRuntimeProofAuthority(nextProofAuthority);
          throw new Error("runtime service mutation authority is unavailable after session rebinding");
        }
        const rotated: FullstackActivation = {
          ...currentRecord,
          context: binding.registryContext,
          runtimeAuthority: binding.runtimeAuthority,
          runtimeAccess: binding.runtimeAccess,
          sessionManager: binding.sessionManager,
          sessionId: binding.sessionId,
          ...(binding.sessionFile !== undefined ? { sessionFile: binding.sessionFile } : {}),
          ...(binding.sessionBasename !== undefined ? { sessionBasename: binding.sessionBasename } : {}),
          ...(binding.generation !== undefined ? { generation: binding.generation } : {}),
          proofAuthority: nextProofAuthority,
          serviceAuthority: nextServiceAuthority,
        };
        if (currentMap?.get(root) !== currentRecord || currentContexts?.get(root) !== currentRecord.context) {
          const owner = currentMap?.get(root);
          const bindingOwned = owner?.context === binding.registryContext
            && owner.runtimeAuthority === binding.runtimeAuthority
            && owner.runtimeAccess === binding.runtimeAccess;
          if (!bindingOwned) currentRecord.sessionBindingController.release(binding);
          transientBinding = undefined;
          revokeCtoRuntimeProofAuthority(nextProofAuthority);
          revokeCtoRuntimeServiceMutationAuthority(nextServiceAuthority);
          throw new Error("activation record changed before session rebinding commit");
        }
        const rotatedRecord: FullstackActivation = { ...rotated, binding };
        currentMap.set(root, rotatedRecord);
        currentContexts.set(root, binding.registryContext);
        ownedRecord = rotatedRecord;
        transientBinding = undefined;
        revokeCtoRuntimeProofAuthority(oldProofAuthority);
        revokeCtoRuntimeServiceMutationAuthority(oldServiceAuthority);
        const slots = fullstackRuntimeAccesses.get(pi as object);
        const oldSlot = slots?.get(root);
        if (oldSlot && oldSlot.access !== binding.runtimeAccess) {
          closeRuntimeAccessSlot(root, oldSlot);
          slots?.delete(root);
        }
        if (slots) {
          slots.set(root, {
            sessionId: binding.sessionId,
            lexicalRoot: pinnedRoot.lexical_root,
            authority: binding.runtimeAuthority,
            access: binding.runtimeAccess,
          });
          runtimeAccessByRoot.set(root, binding.runtimeAccess);
          runtimeAccessByRoot.set(pinnedRoot.lexical_root, binding.runtimeAccess);
        }
      } else {
        const currentAuthority = ctoRuntimeSessionAuthorityForContext(currentRecord.context);
        if (!currentAuthority || currentAuthority !== currentRecord.runtimeAuthority) throw new Error("runtime session authority is stale");
      }
    } catch (error) {
      if (transientBinding) ownedRecord.sessionBindingController.release(transientBinding);
      evictFullstackRoot(pi, root, ownedRecord);
      if (freshRetryAvailable) {
        freshRetryAvailable = false;
        continue;
      }
      pinnedRoot.close();
      console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: "activation_revoked", error: String(error instanceof Error ? error.message : error) }));
      return false;
    }
    const revalidated = openWorkflowActivation(root, ["workflow_registration", "workflow_tools", "config_writer"], fullstackOwnerForCwd);
    if (!revalidated.ok) {
      evictFullstackRoot(pi, root, ownedRecord);
      if (freshRetryAvailable && (revalidated.code === "owner_conflict" || revalidated.code === "activation_identity_changed")) {
        freshRetryAvailable = false;
        continue;
      }
      pinnedRoot.close();
      console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: revalidated.code, error: revalidated.error }));
      return false;
    }
    // Revalidation is a temporary marker/context probe. Never rotate the
    // retained activation context: close the probe immediately, and reject
    // the event if it unexpectedly acquired a fresh capability lease.
    if (revalidated.newly_claimed.length > 0) {
      try { closeWorkflowActivation(revalidated); } catch { /* continue with eviction */ }
      evictFullstackRoot(pi, root, ownedRecord);
      pinnedRoot.close();
      console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: "owner_conflict", error: "activation revalidation unexpectedly acquired new capabilities" }));
      return false;
    }
    try { closeWorkflowActivation(revalidated); } catch (error) {
      evictFullstackRoot(pi, root, ownedRecord);
      if (freshRetryAvailable) {
        freshRetryAvailable = false;
        continue;
      }
      pinnedRoot.close();
      console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: "activation_identity_changed", error: String(error instanceof Error ? error.message : error) }));
      return false;
    }
    pinnedRoot.close();
    return true;
  }
  const prior = fullstackActivations.get(pi as object);
  const retainedContexts = fullstackActivationContexts.get(pi as object);
  if (prior?.has(root) || retainedContexts?.has(root)) {
    evictFullstackRoot(pi, root);
  }
  const activation = openWorkflowActivation(root, ["workflow_registration", "workflow_tools", "config_writer"], fullstackOwnerForCwd);
  if (!activation.ok) {
    pinnedRoot.close();
    console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: activation.code, error: activation.error }));
    return false;
  }
  const initialSession = initialSessionContext === undefined
    ? undefined
    : initialSessionIdentityForContext(initialSessionContext);
  if (initialSessionContext !== undefined && !initialSession) {
    try { closeWorkflowActivation(activation); } catch { /* activation teardown is best-effort */ }
    pinnedRoot.close();
    console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: "activation_context_missing", error: "host session identity snapshot is unavailable" }));
    return false;
  }
  const transaction = beginRegistryRegistration(activation.registry_context, root, FULLSTACK_REGISTRY_FAMILIES);
  if (!transaction.ok) {
    try { closeWorkflowActivation(activation); } catch { /* activation teardown is best-effort */ }
    pinnedRoot.close();
    console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: transaction.code, error: transaction.error }));
    return false;
  }

  let retainedLiveGuard: FullstackActivationLiveGuard;
  try {
    retainedLiveGuard = createRegistryRegistrationLiveGuard(transaction.token, "workflow_tools");
    retainedLiveGuard();
  } catch (error) {
    try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve registration failure */ }
    try { closeWorkflowActivation(activation); } catch { /* activation teardown is best-effort */ }
    pinnedRoot.close();
    console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: "registration_failed", error: String(error instanceof Error ? error.message : error) }));
    return false;
  }
  let gateKey: string | undefined;
  let gateInstalled = false;
  let sessionBindingController: TeamSessionBindingController | undefined;
  let initialBinding: TeamSessionRuntimeBinding | undefined;
  let proofAuthority: CtoRuntimeProofAuthority | undefined;
  let serviceAuthority: CtoRuntimeServiceMutationAuthority | undefined;
  try {
    registerNativeSpecificationAssets(transaction.token);
    const installConstitutionGate = registerTeamWorkflow(pi, {
      label: "omp-workflows-fullstack",
      roles: fullstackPreset.roles,
      scopeMap: fullstackPreset.scopeMap,
      flags: fullstackPreset.flags,
      scopeRuntimeClasses: fullstackPreset.scopeRuntimeClasses,
      scopeUiClasses: fullstackPreset.scopeUiClasses,
      resolveCwd: resolveSessionCwd,
      owner: fullstackOwnerForCwd,
      cwd: root,
      registrationToken: transaction.token,
      ...(initialSessionContext !== undefined ? { initialSessionContext } : {}),
      ...(initialSession ? { initialSession } : {}),
      onSessionBindingController: (controller) => { sessionBindingController = controller; },
      deferConstitutionGate: true,
    });
    if (!sessionBindingController || initialSessionContext === undefined) throw new Error("activation_context_missing: team session binding controller or host context is unavailable");
    const binding = sessionBindingController.bind(initialSessionContext);
    initialBinding = binding ?? undefined;
    const currentBinding = sessionBindingController.current(initialSessionContext);
    if (!binding || !currentBinding || binding.registryContext !== currentBinding.registryContext
      || binding.runtimeAuthority !== currentBinding.runtimeAuthority
      || binding.runtimeAccess !== currentBinding.runtimeAccess) throw new Error("activation_context_missing: team session binding controller rejected the host context");
    const runtimeAuthority = binding.runtimeAuthority;
    const runtimeAccess = binding.runtimeAccess;
    proofAuthority = openCtoRuntimeProofAuthority(binding.registryContext, pinnedRoot) ?? undefined;
    if (!proofAuthority) throw new Error("activation_context_missing: fullstack runtime proof authority is unavailable");
    serviceAuthority = openCtoRuntimeServiceMutationAuthority(binding.registryContext, pinnedRoot) ?? undefined;
    if (!serviceAuthority) throw new Error("activation_context_missing: fullstack runtime service mutation authority is unavailable");
    registerWorkflowTools(pi, transaction.token);
    if (pi.zod) {
      const priorLectureMount = fullstackLectureMounts.get(pi as object);
      if (priorLectureMount === "failed") {
        throw new Error("owner_conflict: lecture acquisition tool mount is terminally failed");
      }
      if (priorLectureMount === undefined) {
        // Mark failed before entering host code: a host that captures a
        // handler and then throws must leave that handler inert forever for
        // this pi rather than retrying a partial registration. The handler
        // resolves the current authenticated root at every execution, so a
        // session move must not remount it.
        fullstackLectureMounts.set(pi as object, "failed");
        registerLectureAcquireTool(pi, pi.zod.z, {
          resolveSessionCwd,
          isMainSessionContext,
          ensureLiveActivation: (ctx, cwd) => ensureLectureLiveActivation(pi, ctx, cwd),
        });
        fullstackLectureMounts.set(pi as object, "active");
      }
    }
    gateKey = root + "\0" + activation.claim.principal_fingerprint;
    gateInstalled = !fullstackGateInstallations.has(gateKey);
    if (gateInstalled) {
      installConstitutionGate?.();
      fullstackGateInstallations.add(gateKey);
    }
    commitRegistryRegistration(transaction.token);
    const activated = fullstackActivations.get(pi as object) ?? new Set<string>();
    activated.add(root);
    const contexts = fullstackActivationContexts.get(pi as object) ?? new Map<string, RegistryRegistrationContext>();
    contexts.set(root, binding.registryContext);
    fullstackActivationContexts.set(pi as object, contexts);
    fullstackActivations.set(pi as object, activated);
    const activationRecords = fullstackActivationRecords.get(pi as object) ?? new Map<string, FullstackActivation>();
    activationRecords.set(root, {
      context: binding.registryContext,
      runtimeAuthority,
      runtimeAccess,
      sessionManager: binding.sessionManager,
      sessionId: binding.sessionId,
      ...(binding.sessionFile !== undefined ? { sessionFile: binding.sessionFile } : {}),
      ...(binding.sessionBasename !== undefined ? { sessionBasename: binding.sessionBasename } : {}),
      ...(binding.generation !== undefined ? { generation: binding.generation } : {}),
      sessionBindingController,
      binding,
      proofAuthority,
      serviceAuthority,
      liveGuard: retainedLiveGuard,
      leases: [{ activation }],
    });
    fullstackActivationRecords.set(pi as object, activationRecords);
    fullstackActiveRootByPi.set(pi as object, root);
    initialBinding = undefined;
    return true;
  } catch (error) {
    try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve the registration failure */ }
    if (gateInstalled && gateKey) fullstackGateInstallations.delete(gateKey);
    if (initialBinding && sessionBindingController) sessionBindingController.release(initialBinding);
    if (proofAuthority) revokeCtoRuntimeProofAuthority(proofAuthority);
    if (serviceAuthority) revokeCtoRuntimeServiceMutationAuthority(serviceAuthority);
    try { closeWorkflowActivation(activation); } catch { /* activation teardown is best-effort */ }
    console.warn("[omp-workflows-fullstack]", JSON.stringify({ code: "registration_failed", error: String(error instanceof Error ? error.message : error) }));
    return false;
  } finally {
    pinnedRoot.close();
  }
}

export default function ompWorkflowsFullstack(pi: ExtensionAPI): void {
  // Core mounted CTO tools resolve this module-private provider; no model or
  // caller-supplied facade crosses the tool boundary. Root/session eviction
  // fences stale entries, while the host session teardown unregisters it.
  registerFullstackRuntimeAccessProvider(pi);
  // Workflow commands publish synchronously for slash discovery. Their
  // session-start owner claim runs before the activation transaction below.
  registerWorkflowCommands(pi, { owner: fullstackOwnerForCwd, resolveCwd: resolveSessionCwd });
  pi.on("session_start", (_event: unknown, ctx: unknown) => {
    if (!isMainSessionContext(ctx)) return;
    const cwd = resolveSessionCwd(ctx);
    if (cwd) ensureFullstackActivation(pi, cwd, ctx);
  });
  // Register the model-role command during extension load, before OMP snapshots
  // slash suggestions or discovers project-local assets.
  registerModelRolesCommand(pi, {
    resolveCwd: resolveSessionCwd,
    ensureLiveActivation: (ctx, cwd) => ensureFullstackLiveRoot(pi, ctx, cwd, true),
    issueResearchAuthorization: (ctx, cwd, payload) => issueResearchRequestAuthorization(pi, ctx, cwd, payload),
  });

  // Marker detector for `/omp-model-roles recommendations` — fires before
  // each agent loop and injects a developer-attributed instruction only after
  // the registered command's exact one-time authorization envelope is verified.
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: unknown) => guardedBeforeAgentStartMarkerHandler(pi, event, ctx));

  // CTO-mode reminder — fires before EVERY LLM call only for a session-local
  // trusted activation (explicit /cto or authenticated messenger admission).
  // Canonical .work-state/cto state alone never activates this hook. The
  // reminder carries only the opaque run identity and fixed delegation
  // contract; restart requires a fresh explicit activation. See
  // cto-mode-reminder.ts.
  pi.on("context", createCtoModeReminderHandler());

  // Messenger-mode `ask` redirect: while a bidirectional channel (telegram)
  // AND an active CTO run exist, block the interactive `ask` tool so ALL
  // user communication goes through the messenger (outbox -> answers/).
  pi.on("tool_call", createAskRedirectGate(resolveSessionCwd, runtimeAccessForCwd, (cwd, ctx) => proofAuthorityForCwd(pi, cwd, ctx)));

  // `/subagents` — toggle / mode / clear for the live subagent-tree widget.
  // The controller is created lazily; if no session_start has run yet
  // the command reports a friendly "no active session" message.
  pi.registerCommand("subagents", {
    description: "Toggle the live subagent-tree widget (on/off/toggle/verbose/compact/clear/status)",
    handler: (args, ctx): Promise<void> => {
      const controller = subagentTreeRef.current;
      if (!controller) {
        ctx.ui.notify("subagent-tree: no active session yet", "info");
        return Promise.resolve();
      }
      const requestedCwd = resolveSessionCwd(ctx);
      const liveCwd = requestedCwd ? ensureFullstackLiveRoot(pi, ctx, requestedCwd, true) : null;
      if (!liveCwd) {
        ctx.ui.notify("subagent-tree: no active session for this root", "warning");
        return Promise.resolve();
      }
      let currentPin: PinnedProjectRoot | null = null;
      let controllerPin: PinnedProjectRoot | null = null;
      try {
        currentPin = openSessionRoot(liveCwd);
        controllerPin = openSessionRoot(controller.cwd);
        if (!currentPin || !controllerPin || !currentPin.isStable() || !controllerPin.isStable()
          || dispatcherRootIdentity(currentPin) !== dispatcherRootIdentity(controllerPin)) {
          ctx.ui.notify("subagent-tree: no controller for this session", "warning");
          return Promise.resolve();
        }
        const message = handleSubagentsCommand(controller, currentPin.canonical_root, ctx.ui, args);
        ctx.ui.notify(message, "info");
        return Promise.resolve();
      } catch {
        ctx.ui.notify("subagent-tree: no controller for this session", "warning");
        return Promise.resolve();
      } finally {
        currentPin?.close();
        controllerPin?.close();
      }
    },
  });
  // Extension-registered commands are authoritative on supported OMP hosts.
  // A silent SessionManager move can trigger an automatic rebind at the same
  // time as the host's eventual session_switch event; share one operation so
  // those paths cannot race two generations against each other.
  const pendingDispatcherRebindByPi = new WeakMap<object, Promise<void>>();
  const pendingCtoWakes = new Map<string, PendingCtoWake>();
  const sessionLifecycleEpochByPi = new WeakMap<object, number>();
  const sessionLifecycleHandler = async (event: unknown, ctx: unknown): Promise<void> => {
    // Subagents emit the same host hook but must never participate in the main
    // lifecycle generation or revoke the interactive dispatcher.
    if (!isMainSessionContext(ctx)) return;
    const contextIdentity = dispatcherContextIdentity(ctx);
    const cwd = resolveSessionCwd(ctx);
    if (!contextIdentity || !cwd) return;
    const eventRecord = event && typeof event === "object" ? event as { sessionId?: unknown; session_id?: unknown; generation?: unknown; sessionGeneration?: unknown; session_generation?: unknown } : undefined;
    const eventSessionId = eventRecord?.sessionId ?? eventRecord?.session_id;
    const eventGeneration = eventRecord?.generation ?? eventRecord?.sessionGeneration ?? eventRecord?.session_generation;
    // Validate immutable event claims before touching epoch/retirement state.
    if (eventSessionId !== undefined && (typeof eventSessionId !== "string" || eventSessionId !== contextIdentity.owner)) return;
    if (eventGeneration !== undefined && (!validHostGeneration(eventGeneration)
      || (contextIdentity.sessionGeneration !== undefined && eventGeneration !== contextIdentity.sessionGeneration))) return;
    fullstackLifecycleAdmissionByPi.set(pi as object, Object.freeze({
      sessionManager: contextIdentity.sessionManager,
      owner: contextIdentity.owner,
      rootIdentity: contextIdentity.rootIdentity,
      cwd: contextIdentity.cwd,
      ...(contextIdentity.sessionGeneration === undefined ? {} : { sessionGeneration: contextIdentity.sessionGeneration }),
    }));
    const ui = extractUiFromContext(ctx);
    const piObject = pi as object;
    const lifecycleEpoch = (sessionLifecycleEpochByPi.get(piObject) ?? 0) + 1;
    sessionLifecycleEpochByPi.set(piObject, lifecycleEpoch);
    const sessionManager = authoritativeSessionManager(ctx);
    const lifecycleIdentity: DispatcherContextIdentity = contextIdentity;
    if (sessionManager && isRetiredDispatcherManager(pi, lifecycleIdentity)) return;
    const pendingManager = dispatcherPendingManagerByPi.get(piObject);
    const pendingIdentity = dispatcherPendingManagerIdentityByPi.get(piObject);
    if (sessionManager && pendingManager && pendingIdentity && (pendingManager !== sessionManager
      || managerIdentityKey(pendingIdentity) !== managerIdentityKey(lifecycleIdentity))) {
      retireDispatcherManager(pi, pendingIdentity);
    }
    if (sessionManager) {
      dispatcherPendingManagerByPi.set(piObject, sessionManager);
      dispatcherPendingManagerIdentityByPi.set(piObject, lifecycleIdentity);
    }
    const currentOwnership = dispatcherCurrentOwnershipByPi.get(piObject);
    if (eventGeneration !== undefined && (typeof eventGeneration !== "string" && typeof eventGeneration !== "number"
      || (contextIdentity.sessionGeneration !== undefined && eventGeneration !== contextIdentity.sessionGeneration))) return;
    const isLatestLifecycleEvent = (): boolean => {
      if (sessionLifecycleEpochByPi.get(piObject) !== lifecycleEpoch) return false;
      const current = dispatcherContextIdentity(ctx);
      const currentManager = authoritativeSessionManager(ctx);
      const currentGeneration = current?.sessionGeneration;
      return current !== null && current.owner === contextIdentity.owner && current.cwd === contextIdentity.cwd
        && (current.sessionFile ?? null) === (contextIdentity.sessionFile ?? null)
        && currentManager === sessionManager
        && (eventSessionId === undefined || eventSessionId === contextIdentity.owner)
        && (eventGeneration === undefined || currentGeneration === undefined || eventGeneration === currentGeneration);
    };
    // Main-session-only dispatcher ownership. Task subagents never reach this
    // point and therefore cannot revoke or advance the lifecycle generation.
    // The session manager identity is canonical for lifecycle hooks. Keep
    // it with this start generation so late events cannot cross a session/root fence.
    const sessionId = contextIdentity.owner;
    // A host may emit session_start for a restart without a preceding switch
    // event. Supersede the prior API owner before acquiring a new generation,
    // including its runtime capability and activation lease. This must precede
    // activation validation so same-root restarts can reopen a fresh lease.
    if (!isLatestLifecycleEvent()) return;
    await revokeCurrentDispatcher(pi, null);
    if (!isLatestLifecycleEvent()) return;
    // Root migration revokes the prior runtime synchronously but dispatcher
    // stop is asynchronous. Await it before claiming the new lexical root:
    // rename(A, B) moves A's lock into B, so a live old lease would otherwise
    // make the new dispatcher appear to be an owner conflict.
    await awaitPendingDispatcherStops(pi);
    if (!isLatestLifecycleEvent()) return;
    if (!ensureFullstackActivation(pi, cwd, ctx)) return;
    if (!isLatestLifecycleEvent()) return;
    // Discovery may run only after a valid activation, and publication
    // revalidates that same root/owner immediately before writing.
    void refreshFullstackAgentMappings(cwd, undefined, () => isLatestLifecycleEvent() && ensureFullstackActivation(pi, cwd)).catch(() => undefined);
    const pinnedRoot = openSessionRoot(cwd);
    if (!pinnedRoot) return;
    let dispatcherOwnsRoot = false;
    try {
      if (!pinnedRoot.isStable()) return;
      const durableCwd = pinnedRoot.canonical_root;
      deactivateCtoMode(durableCwd, sessionId);
      const rootIdentity = dispatcherRootIdentity(pinnedRoot);
      const previous = dispatcherStopsByRootIdentity.get(rootIdentity);
      if (previous) {
        // A new main-session start explicitly takes over this immutable root.
        await previous.stop();
        if (!isLatestLifecycleEvent()) return;
        if (dispatcherStopsByRootIdentity.get(rootIdentity) === previous) dispatcherStopsByRootIdentity.delete(rootIdentity);
      }
      // A same lexical path that was replaced has a new immutable identity.
      // Its old dispatcher must still be stopped during explicit takeover;
      // shutdown remains identity-keyed and never falls back to this path.
      for (const [key, candidate] of dispatcherStopsByRootIdentity) {
        if (key === rootIdentity || candidate.lexicalRoot !== pinnedRoot.lexical_root) continue;
        await candidate.stop();
        if (!isLatestLifecycleEvent()) return;
        if (dispatcherStopsByRootIdentity.get(key) === candidate) dispatcherStopsByRootIdentity.delete(key);
      }
      const runtimeAccess = runtimeAccessForSession(pi, cwd, sessionId);
      if (!runtimeAccess) return;
      const activationRecord = fullstackActivationRecords.get(pi as object)?.get(durableCwd);
      if (!activationRecord) return;
      bindCtoRuntimeAccess(durableCwd, sessionId, runtimeAccess);
      let channelSet: ReturnType<typeof createChannelSet>;
      try {
        channelSet = createChannelSet(durableCwd, undefined, pinnedRoot, runtimeAccess, activationRecord.proofAuthority);
      } catch (error) {
        if (error instanceof EscalationConfigError) {
          ui?.notify(ESCALATION_CONFIG_BLOCKED_NOTICE, "warning");
          return;
        }
        throw error;
      }
      // The RW primary is the only adapter wired/polled for inbound; RO sinks
      // are outbound report sinks only.
      if (channelSet.profiles.length === 0 || !pinnedRoot.isStable()) return;
      // Online ACK: with a validated RW primary AND an active resident run,
      // queue a durable online-ack delivery BEFORE the dispatcher starts —
      // its immediate first tick drains it. No active run -> no ACK (standby
      // creation belongs to /cto, not the dispatcher).
      if (channelSet.profile.direction === "rw") {
        const active = runtimeAccess.findActiveRun();
        if (!pinnedRoot.isStable()) return;
        if (active) {
          try {
            const assertAckLive = (): void => {
              runtimeAccess.assertLive();
              if (!pinnedRoot.isStable()) {
                const error = new Error("dispatcher project root identity changed") as Error & { code: string };
                error.code = "activation_revoked";
                throw error;
              }
            };
            assertAckLive();
            queueCtoDelivery(durableCwd, active.runId, {
              id: `${active.runId}/system/ack/${Date.now()}`,
              level: "question",
              title: "CTO online",
              body: `resident run ${active.runId} standby — awaiting tasks (wave admission + outbox delivery active)`,
              intent: "ack",
              target: channelSet.profile.ackTarget,
            }, pinnedRoot, undefined, runtimeAccess);
            assertAckLive();
          } catch (error) {
            if ((error as { code?: unknown })?.code === "activation_revoked") {
              evictFullstackRoot(pi, durableCwd);
              return;
            }
            throw error;
          }
        }
      }
      if (!pinnedRoot.isStable()) return;
      const generation = ++nextDispatcherGeneration;
      rememberDispatcherManagerGeneration(pi, ctx, generation);
      const ownership: DispatcherOwnership = {
        owner: sessionId,
        sessionManager: sessionManager ?? undefined,
        rootIdentity,
        cwd: durableCwd,
        generation,
        sessionFile: contextIdentity.sessionFile,
        sessionGeneration: contextIdentity.sessionGeneration,
      };
      // Keep the lexical argument paired with the exact descriptor pin. The
      // pin supplies canonical descriptor-relative access; reopening the
      // canonical pathname here would reject the borrowed Darwin anchor.
      let requestWakeStop: (() => Promise<void>) | undefined;
      let identityRevoked = false;
      let replacementStarted = false;
      const revokeAndRebindIdentity = (): void => {
        if (replacementStarted) return;
        replacementStarted = true;
        void requestWakeStop?.();
        void requestDispatcherRebind(ctx).catch(() => undefined);
      };
      const assertDispatcherIdentityLive = (): void => {
        if (identityRevoked) {
          const error = new Error("dispatcher session identity changed") as Error & { code: string };
          error.code = "activation_revoked";
          throw error;
        }
        if (!dispatcherIdentityMatches(pi, ctx, ownership)) {
          identityRevoked = true;
          revokeAndRebindIdentity();
          const error = new Error("dispatcher session identity changed") as Error & { code: string };
          error.code = "activation_revoked";
          throw error;
        }
      };
      const guardedRuntimeAccess = withDispatcherIdentityGuard(runtimeAccess, assertDispatcherIdentityLive);
      const activationLiveGuard = activationRecord.liveGuard;
      const activationSnapshot: RegistryContextSnapshot | undefined = (() => {
        try { return activationLiveGuard?.(); } catch { return undefined; }
      })();
      if (!activationLiveGuard || !activationSnapshot) return;
      const assertWakeLive = (): void => {
        assertDispatcherIdentityLive();
        if (!pinnedRoot.isStable()) {
          const error = new Error("dispatcher project root identity changed") as Error & { code: string };
          error.code = "activation_revoked";
          throw error;
        }
      };
      const dispatcher = startChannelDispatcher(pinnedRoot.lexical_root, channelSet, 10_000, {
        pinnedRoot,
        runtimeAccess: guardedRuntimeAccess,
        serviceAuthority: activationRecord.serviceAuthority,
        proofAuthority: activationRecord.proofAuthority,
        session_id: sessionId,
        liveGuard: activationLiveGuard,
        // Wake the CTO session on an inbound task: idle starts a turn,
        // streaming queues as steer. The [CTO-INBOX] envelope is the
        // contract the standby/CTO prompt tells the agent to fold in; the
        // wave id is included when wave admission succeeded.
        onTask: async (task: InboxTask) => {
          let wakePin: PinnedProjectRoot | null = null;
          let wakeToken: string | undefined;
          let pendingWake: PendingCtoWake | undefined;
          try {
            assertWakeLive();
            activateCtoMode(durableCwd, sessionId, task.runId, guardedRuntimeAccess);
            assertWakeLive();
            wakePin = openSessionRoot(durableCwd);
            if (!wakePin || !wakePin.isStable()) {
              const error = new Error("dispatcher wake root is unavailable") as Error & { code: string };
              error.code = "activation_revoked";
              throw error;
            }
            const runId = task.runId ?? "";
            const stateRevision = currentCtoRunRevision(guardedRuntimeAccess, runId);
            if (stateRevision === null) {
              const error = new Error("dispatcher wake run is no longer the active nonterminal run") as Error & { code: string };
              error.code = "activation_revoked";
              throw error;
            }
            wakeToken = ctoWakeReference("inbox", runId, task.id, ctoInboxWakeDigest(task));
            pendingWake = {
              token: wakeToken,
              kind: "inbox",
              runId,
              id: task.id,
              digest: ctoInboxWakeDigest(task),
              stateRevision,
              runtimeAccess: guardedRuntimeAccess,
              completion: newPendingCtoWakeCompletion(),
              owner: ownership.owner,
              sessionManager: ownership.sessionManager,
              rootIdentity: ownership.rootIdentity,
              cwd: ownership.cwd,
              generation: ownership.generation,
              sessionFile: ownership.sessionFile,
              sessionGeneration: ownership.sessionGeneration,
              pin: wakePin,
            };
            rememberPendingCtoWake(pendingCtoWakes, pendingWake);
            wakePin = null;
            assertWakeLive();
            // Only the bounded opaque token crosses the host prompt boundary;
            // full channel bytes stay in the pinned durable inbox record.
            pi.sendUserMessage(buildCtoInboxWakeMessage(task));
            assertWakeLive();
            await pendingWake.completion.promise;
            assertWakeLive();
            if (currentPendingCtoWakeRevision(pendingWake) !== pendingWake.stateRevision) {
              const error = new Error("dispatcher wake run changed before provider hydration") as Error & { code: string };
              error.code = "activation_revoked";
              throw error;
            }
          } catch (error) {
            if (wakeToken) forgetPendingCtoWake(pendingCtoWakes, wakeToken);
            if (wakePin) closePendingCtoWake({
              token: wakeToken ?? "unused",
              kind: "inbox",
              runId: task.runId ?? "",
              id: task.id,
              digest: ctoInboxWakeDigest(task),
              stateRevision: 0,
              runtimeAccess: guardedRuntimeAccess,
              completion: newPendingCtoWakeCompletion(),
              owner: ownership.owner,
              sessionManager: ownership.sessionManager,
              rootIdentity: ownership.rootIdentity,
              cwd: ownership.cwd,
              generation: ownership.generation,
              sessionFile: ownership.sessionFile,
              sessionGeneration: ownership.sessionGeneration,
              pin: wakePin,
            });
            if ((error as { code?: unknown })?.code === "activation_revoked") void requestWakeStop?.();
            throw error;
          }
        },
        // Wake on a user-initiated answer (reply / button) so the agent
        // reacts without waiting for the next checkpoint poll.
        onAnswer: async (answer) => {
          let wakePin: PinnedProjectRoot | null = null;
          let wakeToken: string | undefined;
          let pendingWake: PendingCtoWake | undefined;
          try {
            assertWakeLive();
            wakePin = openSessionRoot(durableCwd);
            if (!wakePin || !wakePin.isStable()) {
              const error = new Error("dispatcher answer root is unavailable") as Error & { code: string };
              error.code = "activation_revoked";
              throw error;
            }
            const stateRevision = currentCtoRunRevision(guardedRuntimeAccess, answer.run_id);
            if (stateRevision === null) {
              const error = new Error("dispatcher answer run is no longer the active nonterminal run") as Error & { code: string };
              error.code = "activation_revoked";
              throw error;
            }
            wakeToken = ctoWakeReference("answer", answer.run_id, answer.id, ctoAnswerWakeDigest(answer));
            pendingWake = {
              token: wakeToken,
              kind: "answer",
              runId: answer.run_id,
              id: answer.id,
              digest: ctoAnswerWakeDigest(answer),
              stateRevision,
              runtimeAccess: guardedRuntimeAccess,
              completion: newPendingCtoWakeCompletion(),
              owner: ownership.owner,
              sessionManager: ownership.sessionManager,
              rootIdentity: ownership.rootIdentity,
              cwd: ownership.cwd,
              generation: ownership.generation,
              sessionFile: ownership.sessionFile,
              sessionGeneration: ownership.sessionGeneration,
              pin: wakePin,
            };
            rememberPendingCtoWake(pendingCtoWakes, pendingWake);
            wakePin = null;
            // Answers follow the same opaque-reference path as tasks; their
            // durable wake-effect record remains on the old root.
            assertWakeLive();
            pi.sendUserMessage(buildCtoAnswerWakeMessage(answer));
            assertWakeLive();
            await pendingWake.completion.promise;
            assertWakeLive();
            if (currentPendingCtoWakeRevision(pendingWake) !== pendingWake.stateRevision) {
              const error = new Error("dispatcher answer run changed before provider hydration") as Error & { code: string };
              error.code = "activation_revoked";
              throw error;
            }
          } catch (error) {
            if (wakeToken) forgetPendingCtoWake(pendingCtoWakes, wakeToken);
            if (wakePin) closePendingCtoWake({
              token: wakeToken ?? "unused",
              kind: "answer",
              runId: answer.run_id,
              id: answer.id,
              digest: ctoAnswerWakeDigest(answer),
              stateRevision: 0,
              runtimeAccess: guardedRuntimeAccess,
              completion: newPendingCtoWakeCompletion(),
              owner: ownership.owner,
              sessionManager: ownership.sessionManager,
              rootIdentity: ownership.rootIdentity,
              generation: ownership.generation,
              cwd: ownership.cwd,
              sessionFile: ownership.sessionFile,
              sessionGeneration: ownership.sessionGeneration,
              pin: wakePin,
            });
            if ((error as { code?: unknown })?.code === "activation_revoked") void requestWakeStop?.();
            throw error;
          }
        },
      });
      requestWakeStop = dispatcher;
      if (!dispatcher.claimed) return;
      const stopDispatcher = dispatcher;
      dispatcherOwnsRoot = true;
      if (!pinnedRoot.isStable()) {
        await stopDispatcher();
        return;
      }
      const slot: DispatcherSlot = {
        owner: sessionId,
        sessionManager: sessionManager ?? undefined,
        rootIdentity,
        lexicalRoot: pinnedRoot.lexical_root,
        cwd: durableCwd,
        generation,
        sessionFile: contextIdentity.sessionFile,
        sessionGeneration: contextIdentity.sessionGeneration,
        stop: stopDispatcher,
      };
      dispatcherStopsByRootIdentity.set(rootIdentity, slot);
      rememberDispatcherOwnership(pi, ownership);
    } finally {
      if (!dispatcherOwnsRoot) await pinnedRoot.closeAsync();
    }
  };
  async function requestDispatcherRebind(ctx: unknown): Promise<void> {
    const existing = pendingDispatcherRebindByPi.get(pi as object);
    if (existing) return existing;
    const operation = (async (): Promise<void> => {
      await revokeCurrentDispatcher(pi, null);
      await sessionLifecycleHandler({ type: "session_start" }, ctx);
    })();
    const tracked = operation.finally(() => {
      if (pendingDispatcherRebindByPi.get(pi as object) === tracked) pendingDispatcherRebindByPi.delete(pi as object);
    });
    pendingDispatcherRebindByPi.set(pi as object, tracked);
    return tracked;
  }
  function maybeRebindAfterStaleWake(pending: PendingCtoWake, ctx: unknown): void {
    const current = dispatcherCurrentOwnershipByPi.get(pi as object);
    // A newer owner already superseded this wake. Never tear that owner down
    // merely because an old opaque marker was replayed.
    if (current && current.generation !== pending.generation) return;
    void requestDispatcherRebind(ctx).catch(() => undefined);
  }
  async function resolvePendingCtoWake(reference: ParsedCtoWakeReference, ctx: unknown): Promise<string | null | undefined> {
    const pending = pendingCtoWakes.get(reference.token);
    if (!pending) return undefined;
    if (pending.kind !== reference.kind
      || pending.runId !== reference.runId
      || pending.id !== reference.id
      || pending.digest !== reference.digest) return undefined;
    const staleError = (message: string): Error & { code: string } => Object.assign(new Error(message), { code: "activation_revoked" });
    const rejectAndRevoke = async (message: string, revokeDispatcher: boolean): Promise<null> => {
      // Reject first: stopDispatcherOwnership waits for tracked callbacks, and
      // the callback itself is waiting on this completion. This ordering fences
      // the old generation without deadlocking its dispatcher stop.
      settlePendingCtoWake(pending, staleError(message));
      forgetPendingCtoWake(pendingCtoWakes, reference.token);
      if (revokeDispatcher) {
        await stopDispatcherOwnership(pi, pending);
        maybeRebindAfterStaleWake(pending, ctx);
      }
      return null;
    };
    if (!dispatcherIdentityMatches(pi, ctx, pending)) {
      // The host may have switched/moved while sendUserMessage was awaiting
      // maintenance. Revoke only this captured generation and leave its full
      // record untouched for retry/inspection on the old pinned root.
      return rejectAndRevoke("dispatcher session identity changed before provider hydration", true);
    }
    // The run authority is independent from cwd/session identity. A terminal
    // R1 or an active-pointer move to R2 must not let an old token read bytes,
    // even when the host manager stayed on the same root.
    if (currentPendingCtoWakeRevision(pending) !== pending.stateRevision) {
      return rejectAndRevoke("dispatcher wake run is no longer the active nonterminal revision", true);
    }
    let text = readPendingCtoWakeText(pending);
    // The descriptor read is fenced on both sides. A replacement, activation
    // revocation, lease loss, terminalization, or active-pointer move during
    // the read rejects the deferred wake and leaves the durable item pending.
    const authorityAfterRead = currentPendingCtoWakeRevision(pending);
    let identityAfterRead = false;
    try {
      pending.runtimeAccess.assertLive();
      identityAfterRead = dispatcherIdentityMatches(pi, ctx, pending);
    } catch {
      identityAfterRead = false;
    }
    if (text === null || authorityAfterRead !== pending.stateRevision || !identityAfterRead) {
      text = null;
      return rejectAndRevoke(
        authorityAfterRead === pending.stateRevision && identityAfterRead
          ? "pending wake durable record is unavailable or tampered"
          : "dispatcher wake authority changed during provider hydration",
        authorityAfterRead !== pending.stateRevision || !identityAfterRead,
      );
    }
    // Resolve only after the post-read fences pass. The awaiting dispatcher
    // callback then performs one final fence before allowing ACK.
    settlePendingCtoWake(pending);
    forgetPendingCtoWake(pendingCtoWakes, reference.token);
    return text;
  }
  pi.on("before_provider_request", async (event: unknown, ctx: unknown): Promise<unknown> => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
    const payload = (event as { payload?: unknown }).payload;
    const memo = new Map<string, string | null | undefined>();
    const transformed = await transformCtoWakePayload(payload, false, async (reference) => {
      if (memo.has(reference.token)) return memo.get(reference.token);
      const value = await resolvePendingCtoWake(reference, ctx);
      memo.set(reference.token, value);
      return value;
    });
    return transformed.changed ? transformed.value : undefined;
  });
  pi.on("session_start", sessionLifecycleHandler);
  const reconcileSessionTransition = async (ctx: unknown): Promise<void> => {
    // Task/subagent runners may emit the same lifecycle events on a shared
    // ExtensionAPI. They never own the interactive dispatcher and therefore
    // must not revoke or rebind its current generation.
    if (!isMainSessionContext(ctx)) return;
    let target = dispatcherContextIdentity(ctx);
    const previous = dispatcherCurrentOwnershipByPi.get(pi as object);
    const pending = pendingDispatcherRebindByPi.get(pi as object);
    if (pending) {
      await pending;
      // The manager can move again while the automatic rebind is stopping the
      // prior generation; never compare against the pre-await identity.
      target = dispatcherContextIdentity(ctx);
    }
    if (!target) return;
    const rebound = dispatcherCurrentOwnershipByPi.get(pi as object);
    if (rebound
      && rebound.owner === target.owner
      && rebound.rootIdentity === target.rootIdentity
      && rebound.cwd === target.cwd
      && (rebound.sessionFile ?? null) === (target.sessionFile ?? null)
      && (rebound.sessionGeneration ?? null) === (target.sessionGeneration ?? null)
      && rebound.sessionManager === target.sessionManager
      && (!previous || rebound.generation !== previous.generation)) return;
    await revokeCurrentDispatcher(pi, target);
    const current = dispatcherCurrentOwnershipByPi.get(pi as object);
    if (current && previous && current.generation === previous.generation && current.rootIdentity === previous.rootIdentity && current.owner === previous.owner && current.cwd === previous.cwd && (current.sessionFile ?? null) === (previous.sessionFile ?? null)
      && (current.sessionGeneration ?? null) === (previous.sessionGeneration ?? null)
      && current.sessionManager === previous.sessionManager) return;
    await sessionLifecycleHandler({ type: "session_start" }, ctx);
  };
  // The host emits these completion events instead of session_start after a
  // session switch/branch/tree transition. Reconciliation fences the old
  // generation before it rebinds the current manager identity. We deliberately
  // do not revoke in the `session_before_*` hooks: a cancelled transition must
  // leave the current dispatcher alive.
  pi.on("session_switch", async (_event: unknown, ctx: unknown) => {
    await reconcileSessionTransition(ctx);
  });
  pi.on("session_branch", async (_event: unknown, ctx: unknown) => {
    await reconcileSessionTransition(ctx);
  });
  pi.on("session_tree", async (_event: unknown, ctx: unknown) => {
    await reconcileSessionTransition(ctx);
  });
  function rejectPendingWakesForOwnership(ownership: DispatcherOwnership): void {
    for (const [token, pending] of pendingCtoWakes) {
      if (pending.owner !== ownership.owner
        || pending.generation !== ownership.generation
        || pending.rootIdentity !== ownership.rootIdentity
        || (pending.sessionFile ?? null) !== (ownership.sessionFile ?? null)
        || (pending.sessionGeneration ?? null) !== (ownership.sessionGeneration ?? null)
        || (pending.sessionManager && ownership.sessionManager && pending.sessionManager !== ownership.sessionManager)) continue;
      settlePendingCtoWake(pending, Object.assign(new Error("dispatcher ownership stopped before provider hydration"), { code: "activation_revoked" }));
      forgetPendingCtoWake(pendingCtoWakes, token);
    }
  }
  async function stopDispatcherOwnership(piForStop: ExtensionAPI, ownership: DispatcherOwnership): Promise<boolean> {
    // Capture the exact slot and activation generation before any await. A
    // later session may install a replacement at the same root; stale cleanup
    // must never stop or evict that replacement.
    const expectedSlot = dispatcherStopsByRootIdentity.get(ownership.rootIdentity);
    const expectedRecord = fullstackActivationRecords.get(piForStop as object)?.get(ownership.cwd);
    if (!expectedSlot || expectedSlot.owner !== ownership.owner || expectedSlot.generation !== ownership.generation
      || expectedSlot.cwd !== ownership.cwd || (expectedSlot.sessionFile ?? null) !== (ownership.sessionFile ?? null)
      || (expectedSlot.sessionManager && ownership.sessionManager && expectedSlot.sessionManager !== ownership.sessionManager)
      || (expectedSlot.sessionGeneration ?? null) !== (ownership.sessionGeneration ?? null)) {
      forgetDispatcherOwnership(piForStop, ownership);
      return false;
    }
    deactivateCtoMode(expectedSlot.cwd, ownership.owner);
    rejectPendingWakesForOwnership(ownership);

    let stopError: unknown;
    try { await Promise.resolve(expectedSlot.stop()); }
    catch (error) { stopError = error; }

    // Evict only when both the dispatcher slot and activation record are still
    // the exact objects captured above. If a replacement won, stale shutdown
    // is a no-op beyond its own ownership bookkeeping.
    const slotStillCurrent = dispatcherStopsByRootIdentity.get(ownership.rootIdentity) === expectedSlot;
    const recordStillCurrent = fullstackActivationRecords.get(piForStop as object)?.get(ownership.cwd) === expectedRecord;
    if (expectedRecord && slotStillCurrent && recordStillCurrent) {
      dispatcherStopsByRootIdentity.delete(ownership.rootIdentity);
    }
    forgetDispatcherOwnership(piForStop, ownership);
    if (stopError !== undefined) throw stopError;
    return slotStillCurrent && recordStillCurrent;
  }

  async function revokeCurrentDispatcher(piForRevoke: ExtensionAPI, next?: DispatcherContextIdentity | null): Promise<void> {
    const current = dispatcherCurrentOwnershipByPi.get(piForRevoke as object);
    if (!current) return;
    if (next
      && current.owner === next.owner
      && current.rootIdentity === next.rootIdentity
      && current.cwd === next.cwd
      && (current.sessionFile ?? null) === (next.sessionFile ?? null)
      && (current.sessionGeneration ?? null) === (next.sessionGeneration ?? null)
      && (!current.sessionManager || !next.sessionManager || current.sessionManager === next.sessionManager)) return;
    await stopDispatcherOwnership(piForRevoke, current);
  }

  pi.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
    if (!isMainSessionContext(ctx)) return;
    const identity = dispatcherContextIdentity(ctx);
    if (!identity) return;
    const ownership = ownershipForContext(pi, ctx, identity);
    // An unrecognized or stale context must not evict a newer same-root
    // activation. Only the exact remembered dispatcher ownership may clean up.
    if (!ownership) return;
    const expectedRecord = fullstackActivationRecords.get(pi as object)?.get(identity.cwd);
    const expectedRuntimeSlot = fullstackRuntimeAccesses.get(pi as object)?.get(identity.cwd);
    const stoppedCurrent = await stopDispatcherOwnership(pi, ownership);
    if (stoppedCurrent && expectedRecord && fullstackActivationRecords.get(pi as object)?.get(identity.cwd) === expectedRecord) {
      evictFullstackRoot(pi, identity.cwd, expectedRecord, expectedRuntimeSlot);
      if ((fullstackRuntimeAccesses.get(pi as object)?.size ?? 0) === 0) unregisterFullstackRuntimeAccessProvider(pi);
    }
  });
}

// ── Native specification recognizers (T070) ─────────────────────────────────
export {
  genericRecognizer,
  registerSpecificationRecognizers,
  specificationRecognizerById,
  specificationRecognizers,
} from "./specification/recognizers/registry.js";
// ── cto-safety (br-zps.4, br-zps.5, br-zps.6) ──
export { MockEscalationAdapter } from "./adapters/mock.js";
export * from "./lecture-acquisition/eval.js";
export {
  SPECKIT_CONSTITUTION_PROVIDER_ID,
  SPECKIT_CONSTITUTION_RELATIVE_PATH,
  speckitConstitutionProvider,
} from "./specification/providers/speckit.js";

export {
  FULLSTACK_ACTIVATION_MARKER_BYTES,
  FULLSTACK_ACTIVATION_MARKER_PATH,
  FULLSTACK_ACTIVATION_MARKER_SHA256,
  parseFullstackActivationMarker,
  readFullstackActivationMarker,
  writeFullstackActivationMarker,
} from "./activation-marker.js";
