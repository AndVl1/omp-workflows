/**
 * @andvl1/omp-workflows-fullstack — default omp-workflows bundle.
 *
 * Registers the workflow engine (gates + role mapping) with OMP and
 * auto-bootstraps the shipped custom-TS slash commands into the active
 * project's `.omp/commands/` directory on every session start.
 *
 * Also wires the live subagent-tree widget (see `subagent-tree.ts`) and
 * exposes a `/subagents` toggle command.
 *
 * For a custom bundle (e.g. Rust, Go-only, or any non-fullstack stack),
 * write your own package that calls `registerTeamWorkflow(pi, { roles: ..., ... })`
 * with your own role mapping. Do not depend on this package.
 */

import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionUIContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  SessionStartEvent,
} from "@oh-my-pi/pi-coding-agent";
import {
  createWorkflowSessionController,
  createWorkflowToolAdapter,
  findActiveCtoRun,
  registerTeamWorkflow,
  readAgentMapping,
  resolveActiveBranch,
  runTarget,
  type ModelRoleEntry,
  type RoleConfig,
  type ScopeRuntimeClassTable,
  type TrustedExecutionContext,
  type TrustedToolCallResolution,
  type WorkflowOwnerIdentity,
  type WorkflowSessionController,
  type WorkflowToolAdapter,
} from "@andvl1/omp-workflows-core";
import { registerWorkflowCommands } from "./workflow-commands.js";
import { ensureCommandsForSession } from "./copy-commands.js";
import { refreshFullstackAgentMappings, waitForFullstackAgentMappings } from "./agent-mapping.js";
import { createChannelSet, queueCtoDelivery, startChannelDispatcher, type InboxTask } from "./adapters/registry.js";
import { createAskRedirectGate } from "./messenger-channel.js";
import { createCtoModeReminderHandler } from "./cto-mode-reminder.js";
import {
  RESEARCH_REQUEST_MARKER_END,
  RESEARCH_REQUEST_MARKER_START,
  buildResearchRequestDeveloperInstruction,
} from "./before-agent-start-marker.js";
import {
  handleSubagentsCommand,
  registerSubagentTree,
  type SubagentTreeController,
} from "./subagent-tree.js";
import { registerLectureAcquireTool } from "./tools/lecture-acquire.js";
// Auto-derived from core taxonomy; test-invariант в test/omp-model-roles.test.ts:439-446 ловит drift.

export const defaultFullstackRoles: RoleConfig["roles"] = {
  analyst: "analyst",
  "tech-researcher": "tech-researcher",
  diagnostics: "diagnostics",
  architect: "architect",
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

export const defaultFullstackModelRoles: ModelRoleEntry[] = [
  { role: "architect", agents: ["architect"], standardFallback: "@slow" },
  { role: "reviewer", agents: ["code-reviewer"], standardFallback: "@slow" },
  { role: "security", agents: ["security-tester"], standardFallback: "@slow" },
  { role: "researcher", agents: ["tech-researcher", "discovery"], standardFallback: "@smol" },
  { role: "analyst", agents: ["analyst"], standardFallback: "@task" },
  { role: "developer-go", agents: ["developer-go"], standardFallback: "@task" },
  { role: "developer-kotlin", agents: ["developer-kotlin"], standardFallback: "@task" },
  { role: "frontend-developer", agents: ["frontend-developer"], standardFallback: "@task" },
  { role: "developer-mobile", agents: ["developer-mobile", "init-mobile"], standardFallback: "@task" },
  { role: "devops", agents: ["devops"], standardFallback: "@task" },
  { role: "diagnostics", agents: ["diagnostics"], standardFallback: "@task" },
  { role: "qa", agents: ["qa"], standardFallback: "@task" },
  { role: "manual-qa", agents: ["manual-qa"], standardFallback: "@task" },
];

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
export function resolveSessionCwd(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const objectContext = ctx as { cwd?: unknown; sessionManager?: unknown };
	const manager = objectContext.sessionManager;
	if (manager && typeof manager === "object" && "getCwd" in manager && typeof manager.getCwd === "function") {
		try {
			const sessionCwd = manager.getCwd();
			if (typeof sessionCwd === "string" && sessionCwd.length > 0) return sessionCwd;
		} catch {
			// Fall through to the context cwd.
		}
	}
	if (typeof objectContext.cwd === "string" && objectContext.cwd.length > 0) return objectContext.cwd;
	return undefined;
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
 * `before_agent_start` hook: detect the marker envelope produced by the
 * `/omp-model-roles recommendations` custom command and inject an
 * `agent`-attributed developer message so the main LLM treats the four
 * hard steps as developer-priority. The marker is opaque to OMP — see
 * `before-agent-start-marker.ts` for the contract.
 */
function beforeAgentStartMarkerHandler(
	event: BeforeAgentStartEvent,
): BeforeAgentStartEventResult | undefined {
	if (typeof event?.prompt !== "string") return undefined;
	// Marker envelope guard: both start and end markers must be present.
	// A truncated envelope (START without END) would still inject the
	// developer instruction and promise the LLM a payload it can never
	// extract, so we bail with `undefined` and let the regular prompt
	// path handle it. The end marker is exported from the marker module
	// next to the start marker.
	if (!event.prompt.includes(RESEARCH_REQUEST_MARKER_START)) return undefined;
	if (!event.prompt.includes(RESEARCH_REQUEST_MARKER_END)) return undefined;
	return {
		message: {
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
			attribution: "agent",
		},
	};
}

/**
 * Per-session subagent-tree controller. Filled by session_start; consumed by
 * the `/subagents` command handler. Ref pattern keeps the handler registered
 * once at extension load while the controller is bound at session start.
 */
const subagentTreeRef: { current: SubagentTreeController | null } = { current: null };
/** One dispatcher per interactive main session/cwd; subagents must not poll Telegram. */
const dispatcherStopsByCwd = new Map<string, () => void>();
/** One lifecycle controller for the trusted host session currently bound to this bundle. */
type CapturedHostSession = { cwd: string; sessionId: string; mode: "tui" | "rpc" };
type PrimaryHostSessionProfile = CapturedHostSession | { cwd: string; sessionId: string; mode: "headless" };
const workflowSessionRef: { current: WorkflowSessionController | null } = { current: null };
const workflowSessionCapturedAtHostStart = { current: false };
const capturedHostSessionRef: { current: CapturedHostSession | null } = { current: null };
/** Latest primary host profile; headless marks an explicit fail-closed boundary. */
const primaryHostSessionRef: { current: PrimaryHostSessionProfile | null } = { current: null };

function contextSessionId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const value = ctx as {
    session_id?: unknown;
    sessionId?: unknown;
    sessionManager?: { getSessionId?: () => unknown };
  };
  if (typeof value.session_id === "string" && value.session_id.length > 0) return value.session_id;
  if (typeof value.sessionId === "string" && value.sessionId.length > 0) return value.sessionId;
  try {
    const sessionId = value.sessionManager?.getSessionId?.();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}
function authoritativeHostSession(ctx: unknown): { cwd: string; sessionId: string } | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const manager = (ctx as {
    sessionManager?: {
      getCwd?: () => unknown;
      getSessionId?: () => unknown;
    };
  }).sessionManager;
  if (!manager || typeof manager.getCwd !== "function" || typeof manager.getSessionId !== "function") return undefined;
  try {
    const cwd = manager.getCwd();
    const sessionId = manager.getSessionId();
    return typeof cwd === "string" && cwd.length > 0 && typeof sessionId === "string" && sessionId.length > 0
      ? { cwd, sessionId }
      : undefined;
  } catch {
    return undefined;
  }
}

type LifecycleIdentityPart = {
  cwd?: string;
  sessionId?: string;
  sessionManager?: object;
};

function lifecycleIdentityPart(value: unknown): LifecycleIdentityPart {
  if (!value || typeof value !== "object") return {};
  const objectValue = value as { sessionManager?: unknown };
  const cwd = resolveSessionCwd(value);
  const sessionId = contextSessionId(value);
  const sessionManager = objectValue.sessionManager;
  return {
    ...(cwd ? { cwd } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionManager && typeof sessionManager === "object" ? { sessionManager } : {}),
  };
}
function lifecycleIdentity(event: unknown, ctx: unknown): { cwd: string; sessionId: string } | undefined {
  const eventIdentity = lifecycleIdentityPart(event);
  const contextIdentity = lifecycleIdentityPart(ctx);
  if (eventIdentity.sessionId && contextIdentity.sessionId && eventIdentity.sessionId !== contextIdentity.sessionId) return undefined;
  if (eventIdentity.cwd && contextIdentity.cwd) {
    try {
      if (resolve(eventIdentity.cwd) !== resolve(contextIdentity.cwd)) return undefined;
    } catch {
      return undefined;
    }
  }
  if (eventIdentity.sessionManager && contextIdentity.sessionManager && eventIdentity.sessionManager !== contextIdentity.sessionManager) return undefined;
  const cwd = eventIdentity.cwd ?? contextIdentity.cwd;
  const sessionId = eventIdentity.sessionId ?? contextIdentity.sessionId;
  return cwd && sessionId ? { cwd, sessionId } : undefined;
}

function exactLifecycleContext(event: unknown, ctx: unknown): boolean {
  const identity = lifecycleIdentity(event, ctx);
  const authoritative = authoritativeHostSession(ctx);
  return Boolean(identity && authoritative && sameHostSessionIdentity(identity, authoritative));
}

function sameHostSessionIdentity(
  left: { cwd: string; sessionId: string },
  right: { cwd: string; sessionId: string },
): boolean {
  try {
    return left.sessionId === right.sessionId && resolve(left.cwd) === resolve(right.cwd);
  } catch {
    return false;
  }
}

/**
 * A same-identity headless session_start is an explicit fail-closed
 * boundary. It may revoke the retained interactive binding, but a foreign
 * or unverifiable headless start must never mutate another host session.
 */
function invalidateHeadlessHostSession(authoritative: { cwd: string; sessionId: string }): void {
  const current = primaryHostSessionRef.current;
  if (!current || current.mode === "headless" || !sameHostSessionIdentity(current, authoritative)) return;

  const captured = capturedHostSessionRef.current;
  const controller = workflowSessionRef.current;
  if (!captured || !controller || !sameHostSessionIdentity(captured, authoritative)) {
    workflowSessionRef.current = null;
    workflowSessionCapturedAtHostStart.current = false;
    capturedHostSessionRef.current = null;
    primaryHostSessionRef.current = { ...authoritative, mode: "headless" };
    return;
  }
  try {
    const controllerContext = controller.context();
    if (
      controllerContext.session_id !== authoritative.sessionId
      || resolve(controllerContext.worktree) !== resolve(authoritative.cwd)
    ) return;
    controller.release("host-session-unavailable");
    workflowSessionRef.current = null;
    workflowSessionCapturedAtHostStart.current = false;
    capturedHostSessionRef.current = null;
    primaryHostSessionRef.current = { ...authoritative, mode: "headless" };
  } catch {
    // Preserve the controller and claim on failed release. The headless
    // marker still prevents stale interactive authority until reconciliation.
    primaryHostSessionRef.current = { ...authoritative, mode: "headless" };
  }
}

function observePrimaryHostSession(ctx: unknown): void {
  const authoritative = authoritativeHostSession(ctx);
  if (!authoritative) return;
  const current = primaryHostSessionRef.current;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  const headless = value.hasUI === false && (value.mode === undefined || value.mode === "json" || value.mode === "print");
  if (current && sameHostSessionIdentity(current, authoritative)) {
    if (headless) {
      invalidateHeadlessHostSession(authoritative);
      return;
    }
    if (value.hasUI === true && (value.mode === "tui" || value.mode === "rpc")) {
      primaryHostSessionRef.current = { ...authoritative, mode: value.mode };
    }
    return;
  }
  if (current) return;
  if (value.hasUI === true && (value.mode === "tui" || value.mode === "rpc")) {
    primaryHostSessionRef.current = { ...authoritative, mode: value.mode };
  }
}

function clearPrimaryHostSession(ctx: unknown): void {
  const authoritative = authoritativeHostSession(ctx);
  const current = primaryHostSessionRef.current;
  if (authoritative && current && sameHostSessionIdentity(current, authoritative)) {
    primaryHostSessionRef.current = null;
  }
}

function trustedHostSession(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object") return false;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  if (value.mode !== undefined && value.mode !== "tui" && value.mode !== "rpc") return false;
  if (value.hasUI === false) return false;
  if ("mode" in value || "hasUI" in value) {
    return value.hasUI === true && (value.mode === "tui" || value.mode === "rpc")
      || authoritativeHostSession(ctx) !== undefined;
  }
  return authoritativeHostSession(ctx) !== undefined;
}

function captureHostSession(ctx: unknown, authoritative: { cwd: string; sessionId: string }): CapturedHostSession | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  if (value.hasUI !== true || (value.mode !== "tui" && value.mode !== "rpc")) return undefined;
  return { ...authoritative, mode: value.mode };
}

function createWorkflowSession(cwd: string, sessionId: string): WorkflowSessionController | undefined {
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
    return undefined;
  }
}

/**
 * Bind the shared controller before core command/tool registration sees a
 * session_start event. Subagent session events are deliberately ignored:
 * they must never replace or release the interactive host's controller.
 */
function bindWorkflowSession(ctx: unknown): void {
  if (!trustedHostSession(ctx)) return;
  const authoritative = authoritativeHostSession(ctx);
  if (!authoritative) return;
  const cwd = authoritative.cwd;
  const sessionId = authoritative.sessionId;
  const existing = workflowSessionRef.current;
  if (existing) {
    try {
      existing.release("host-session-replaced");
    } catch {
      // Keep the existing binding on failed release; the worktree remains
      // conservatively busy until the owner can be reconciled.
      return;
    }
    workflowSessionRef.current = null;
    workflowSessionCapturedAtHostStart.current = false;
    capturedHostSessionRef.current = null;
  }
  workflowSessionRef.current = createWorkflowSession(cwd, sessionId) ?? null;
  workflowSessionCapturedAtHostStart.current = workflowSessionRef.current !== null;
  capturedHostSessionRef.current = workflowSessionRef.current
    ? captureHostSession(ctx, authoritative) ?? null
    : null;
  // bindWorkflowSession is registered before the core adapter's profile
  // observer. Capture the primary profile here so the very first raw
  // tool_call after session_start has trusted admission.
  const captured = capturedHostSessionRef.current;
  if (workflowSessionRef.current && captured) primaryHostSessionRef.current = captured;
}
function releaseWorkflowSession(event: unknown, ctx: unknown, teardown: boolean): void {
  const stopped = lifecycleIdentity(event, ctx);
  const authoritative = authoritativeHostSession(ctx);
  if (
    !stopped
    || !authoritative
    || !trustedHostSession(ctx)
    || !sameHostSessionIdentity(stopped, authoritative)
  ) return;
  const controller = workflowSessionRef.current;
  if (!controller) {
    if (teardown) {
      const captured = capturedHostSessionRef.current;
      if (!captured || sameHostSessionIdentity(captured, authoritative)) {
        workflowSessionCapturedAtHostStart.current = false;
        capturedHostSessionRef.current = null;
        clearPrimaryHostSession(ctx);
      }
    }
    return;
  }
  try {
    const controllerContext = controller.context();
    if (
      controllerContext.session_id !== authoritative.sessionId ||
      resolve(controllerContext.worktree) !== resolve(authoritative.cwd)
    ) return;
    controller.release("host-session-stop");
    if (!teardown) return;
    workflowSessionRef.current = null;
    workflowSessionCapturedAtHostStart.current = false;
    capturedHostSessionRef.current = null;
    clearPrimaryHostSession(ctx);
  } catch {
    // Preserve the controller and claim on failure; clearing it would hide a
    // live ownership conflict and permit an unsafe replacement.
  }
}
/**
 * Core's workflow-tool adapter invokes this callback only after its captured
 * session_start profile has passed the trusted interactive-session gate. The
 * callback may therefore normalize a UI-less RPC tool context through the
 * controller captured at that trusted ingress, but never through cwd alone.
 */
function capturedHostControllerForTool(
  ctx: unknown,
  cwd: string,
  requestedSession: string | undefined,
): WorkflowSessionController | undefined {
  const captured = capturedHostSessionRef.current;
  const controller = workflowSessionRef.current;
  if (
    !workflowSessionCapturedAtHostStart.current ||
    !captured ||
    !controller ||
    !ctx ||
    typeof ctx !== "object"
  ) return undefined;
  const primary = primaryHostSessionRef.current;
  if (!primary || primary.mode === "headless" || !sameHostSessionIdentity(primary, captured)) return undefined;
  if (resolve(captured.cwd) !== resolve(cwd)) return undefined;
  if (requestedSession && requestedSession !== captured.sessionId) return undefined;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  if (captured.mode === "rpc") {
    if (value.hasUI !== false || (value.mode !== undefined && value.mode !== "rpc")) return undefined;
  } else if (value.hasUI !== true || (value.mode !== undefined && value.mode !== "tui")) {
    return undefined;
  }
  try {
    const controllerContext = controller.context();
    if (
      controllerContext.session_id !== captured.sessionId ||
      resolve(controllerContext.worktree) !== resolve(captured.cwd)
    ) return undefined;
    return controller;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the narrow orchestrator capability for a raw `tool_call`. OMP
 * 18.2.2 omits actor/hasUI on this event, so admission is based only on the
 * already captured interactive host profile plus fresh manager identity.
 */
function resolveFullstackTrustedToolCallActor(
  ctx: unknown,
  cwd: string,
  runId: string | undefined,
): TrustedToolCallResolution | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const captured = capturedHostSessionRef.current;
  const primary = primaryHostSessionRef.current;
  const controller = workflowSessionRef.current;
  if (
    !workflowSessionCapturedAtHostStart.current
    || !captured
    || !primary
    || primary.mode === "headless"
    || !controller
    || !sameHostSessionIdentity(primary, captured)
  ) return undefined;

  const authoritative = authoritativeHostSession(ctx);
  if (
    !authoritative
    || !sameHostSessionIdentity(authoritative, captured)
    || resolve(cwd) !== resolve(captured.cwd)
  ) return undefined;
  const value = ctx as { session_id?: unknown; sessionId?: unknown; mode?: unknown; hasUI?: unknown };
  if (typeof value.session_id === "string" && value.session_id !== captured.sessionId) return undefined;
  if (typeof value.sessionId === "string" && value.sessionId !== captured.sessionId) return undefined;
  if (value.mode !== undefined && value.mode !== captured.mode) return undefined;
  if (value.hasUI !== undefined) {
    if (captured.mode === "rpc" ? value.hasUI !== false : value.hasUI !== true) return undefined;
  }

  try {
    const controllerContext = controller.context();
    if (
      controllerContext.session_id !== captured.sessionId
      || resolve(controllerContext.worktree) !== resolve(captured.cwd)
    ) return undefined;
    const selectedRunId = controller.selectedRunId();
    if (selectedRunId !== runId) return undefined;
    if (runId === undefined) return { kind: "authenticated-interactive-host-no-run" };
    if (!runId || controller.activeClaimRunId() !== runId) return undefined;
    const target = runTarget(captured.cwd, runId);
    const artifactsDir = target.artifactsDir;
    const expectedArtifactsDir = resolve(captured.cwd, ".work-state", "runs", runId, "artifacts");
    if (!artifactsDir || resolve(artifactsDir) !== expectedArtifactsDir) return undefined;
    return { actor: "orchestrator", artifactsDir };
  } catch {
    return undefined;
  }
}
/**
 * Shared accessor passed to commands, tools, and core hooks. The lifecycle
 * ingress is the only authority allowed to create, replace, or capture the
 * controller; this accessor only returns an already-captured exact binding.
 */
export function getFullstackWorkflowSessionController(ctx: unknown, cwd: string): WorkflowSessionController | undefined {
  const requestedSession = contextSessionId(ctx);
  const authoritative = authoritativeHostSession(ctx);
  const captured = capturedHostSessionRef.current;
  const primary = primaryHostSessionRef.current;
  const controller = workflowSessionRef.current;
  if (
    !workflowSessionCapturedAtHostStart.current
    || !requestedSession
    || !authoritative
    || !captured
    || !primary
    || primary.mode === "headless"
    || !controller
    || !sameHostSessionIdentity(primary, captured)
    || !sameHostSessionIdentity(authoritative, captured)
    || resolve(authoritative.cwd) !== resolve(cwd)
    || requestedSession !== captured.sessionId
  ) return undefined;
  const value = ctx && typeof ctx === "object" ? ctx as { mode?: unknown; hasUI?: unknown } : {};
  if (value.mode !== undefined && value.mode !== captured.mode) return undefined;
  if (value.hasUI === false) return undefined;
  if (value.hasUI !== undefined && value.hasUI !== true) return undefined;
  try {
    const controllerContext = controller.context();
    return controllerContext.session_id === captured.sessionId
      && resolve(controllerContext.worktree) === resolve(captured.cwd)
      ? controller
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Raw `tool_call` contexts may be foreign or stale and must never replace the
 * controller captured at session_start. Legitimate replacement happens only
 * through bindWorkflowSession on the lifecycle ingress.
 */
function getFullstackRawWorkflowSessionController(
  ctx: unknown,
  cwd: string,
): WorkflowSessionController | undefined {
  const requestedSession = contextSessionId(ctx);
  const authoritative = authoritativeHostSession(ctx);
  const captured = capturedHostSessionRef.current;
  const primary = primaryHostSessionRef.current;
  const controller = workflowSessionRef.current;
  if (
    !requestedSession
    || !authoritative
    || !captured
    || !primary
    || primary.mode === "headless"
    || !controller
    || !sameHostSessionIdentity(primary, captured)
    || !sameHostSessionIdentity(authoritative, captured)
    || resolve(authoritative.cwd) !== resolve(cwd)
    || requestedSession !== captured.sessionId
  ) return undefined;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  if (value.mode !== undefined && value.mode !== captured.mode) return undefined;
  if (value.hasUI !== undefined && (captured.mode === "rpc" ? value.hasUI !== false : value.hasUI !== true)) return undefined;
  try {
    const controllerContext = controller.context();
    return controllerContext.session_id === captured.sessionId
      && resolve(controllerContext.worktree) === resolve(captured.cwd)
      ? controller
      : undefined;
  } catch {
    return undefined;
  }
}


/** Adapter-only bridge for core's already profile-authenticated tool calls. */
function getFullstackWorkflowToolSessionController(
  ctx: unknown,
  cwd: string,
): WorkflowSessionController | undefined {
  return getFullstackWorkflowSessionController(ctx, cwd)
    ?? capturedHostControllerForTool(ctx, cwd, contextSessionId(ctx));
}

function registerWorkflowSessionProfile(pi: ExtensionAPI): void {
  if (typeof (pi as { on?: unknown }).on !== "function") return;
  pi.on("session_start", (event: unknown, ctx: unknown) => {
    if (!exactLifecycleContext(event, ctx)) return;
    observePrimaryHostSession(ctx);
  });
}

function registerWorkflowSessionController(pi: ExtensionAPI): void {
  if (typeof (pi as { on?: unknown }).on !== "function") return;
  pi.on("session_start", (event: unknown, ctx: unknown) => {
    if (!exactLifecycleContext(event, ctx)) return;
    bindWorkflowSession(ctx);
  });
  pi.on("session_stop", (event: unknown, ctx: unknown) => releaseWorkflowSession(event, ctx, false));
  pi.on("session_shutdown", (event: unknown, ctx: unknown) => releaseWorkflowSession(event, ctx, true));
}

/**
 * Session-level main-session classification for fullstack-owned event
 * surfaces (session_start/session_shutdown, the messenger dispatcher,
 * widget binding). The installed host derives these event contexts from the
 * extension runner's UI context, so trusted RPC main sessions report
 * hasUI=true here even though `--mode rpc` deliberately leaves TOOL-call
 * contexts UI-less — per-call tool eligibility is decided by core's
 * captured session profile, not by this helper. Task subagents run with
 * `hasUI: false` and load the same extension; only the interactive main
 * session may own the product messenger dispatcher, otherwise every
 * lead/worker creates another getUpdates consumer with its own offset.
 * Unknown contexts are treated as main for compatibility with older
 * OMP/test runtimes that did not expose `hasUI` on session_start.
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
    provenance: {
      package: FULLSTACK_BUNDLE_ID,
      entrypoint: "dist/index.js",
      cwd: root,
      config_path: join(root, ".omp", "team.config.json"),
    },
  };
}

const fullstackWorkflowToolAdapter: WorkflowToolAdapter = createWorkflowToolAdapter({
  resolveCwd: resolveSessionCwd,
  owner: fullstackOwnerForCwd,
  isMainSession: isMainSessionContext,
  getSessionController: getFullstackWorkflowToolSessionController,
  beforeBegin: async cwd => { await waitForFullstackAgentMappings(cwd); },
  mappingSummary: summarizeAgentMapping,
});

/** Fullstack keeps only bundle-specific adaptation; core owns tool behavior. */
export function registerWorkflowTools(pi: ExtensionAPI): void {
  registerWorkflowSessionProfile(pi);
  fullstackWorkflowToolAdapter.register(pi);
}


export default function ompWorkflowsFullstack(pi: ExtensionAPI): void {
  registerWorkflowSessionController(pi);
  registerTeamWorkflow(pi, {
    label: "omp-workflows-fullstack",
    roles: fullstackPreset.roles,
    scopeMap: fullstackPreset.scopeMap,
    flags: fullstackPreset.flags,
    getSessionController: getFullstackRawWorkflowSessionController,
    scopeUiClasses: fullstackPreset.scopeUiClasses,
    resolveCwd: resolveSessionCwd,
    owner: fullstackOwnerForCwd,
    resolveTrustedToolCallActor: resolveFullstackTrustedToolCallActor,
  });
  registerWorkflowTools(pi);
  // URL-first lecture research acquisition — main-session only; core owns the
  // workflow state boundary, this bundle owns the provider-specific acquire tool.
  if (pi.zod) {
    const { z } = pi.zod;
    registerLectureAcquireTool(pi, z, { resolveSessionCwd, isMainSessionContext, getSessionController: getFullstackWorkflowSessionController });
  }
  // Register the three workflow entry points while the extension is loaded.
  // OMP snapshots registered commands before it discovers project-local
  // `.omp/commands` files, so this keeps slash suggestions and execution
  // authoritative even when a copied file is stale or cannot resolve the
  // plugin's peer dependency from the consumer cwd.
  registerWorkflowCommands(pi);

  // Marker detector for `/omp-model-roles recommendations` — fires before
  // each agent loop and injects a developer-attributed instruction when
  // the custom command's return value carries the marker envelope.
  pi.on("before_agent_start", beforeAgentStartMarkerHandler);

  // CTO-mode reminder — fires before EVERY LLM call. While a CTO run is
  // active (.work-state/cto/), prepend a short steering message restating
  // the delegation contract (orchestrator -> teams, lead -> workers,
  // worker -> escalate up). Keeps the discipline in front of the model on
  // every turn of long autonomous runs (and after compaction), for the
  // main session and subagents. See cto-mode-reminder.ts.
  pi.on("context", createCtoModeReminderHandler());

  // Messenger-mode `ask` redirect: while a bidirectional channel (telegram)
  // AND an active CTO run exist, block the interactive `ask` tool so ALL
  // user communication goes through the messenger (outbox -> answers/).
  pi.on("tool_call", createAskRedirectGate());

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
      const message = handleSubagentsCommand(controller, controller.cwd, ctx.ui, args);
      ctx.ui.notify(message, "info");
      return Promise.resolve();
    },
  });
  // Keep the project-local command tree synchronized for runtimes that still
  // discover custom-TS commands from disk. The authoritative commands were
  // registered above, before OMP snapshots slash suggestions; this copy is a
  // compatibility fallback and a cache for older runtimes.
  //
  // Best-effort, never throws: any IO error is captured by
  // `ensureCommandsForSession` and dropped.
  pi.on("session_start", (_event: SessionStartEvent, ctx: unknown) => {
    const cwd = resolveSessionCwd(ctx);
    if (!cwd) return;
    ensureCommandsForSession(cwd);
    if (isMainSessionContext(ctx)) {
      void refreshFullstackAgentMappings(cwd).catch(() => undefined);
    }
    // Subagent-tree live widget — bound to the cwd of the active session.
    // The controller replays from <cwd>/.omp/subagent-tree.json so the
    // previous view state (on/off + verbose/compact) survives restarts.
    const ui = extractUiFromContext(ctx);
    if (ui) subagentTreeRef.current = registerSubagentTree(pi, ui, cwd);
    // CTO escalation dispatcher: only the interactive main session may own
    // inbound polling. Task subagents also emit session_start, but starting a
    // dispatcher there creates another getUpdates consumer with offset=0.
    if (!isMainSessionContext(ctx)) return;
    dispatcherStopsByCwd.get(cwd)?.();
    dispatcherStopsByCwd.delete(cwd);
    // Profile-aware channel set (core capability-validated normalization):
    // the RW primary is the only adapter wired/polled for inbound; RO sinks
    // are outbound report sinks only.
    const channelSet = createChannelSet(cwd);
    if (channelSet.profiles.length === 0) return;
    // Online ACK: with a validated RW primary AND an active resident run,
    // queue a durable online-ack delivery BEFORE the dispatcher starts —
    // its immediate first tick drains it. No active run -> no ACK (standby
    // creation belongs to /cto, not the dispatcher).
    if (channelSet.profile.direction === "rw") {
      const sessionId = contextSessionId(ctx);
      const active = sessionId ? findActiveCtoRun(cwd, { sessionId }) : null;
      if (active) {
        queueCtoDelivery(cwd, active.runId, {
          id: `${active.runId}/system/ack/${Date.now()}`,
          level: "question",
          title: "CTO online",
          body: `resident run ${active.runId} standby — awaiting tasks (wave admission + outbox delivery active)`,
          intent: "ack",
          target: channelSet.profile.ackTarget,
        });
      }
    }
    const stopDispatcher = startChannelDispatcher(cwd, channelSet, 10_000, {
      // Wake the CTO session on an inbound task: idle starts a turn,
      // streaming queues as steer. The [CTO-INBOX] envelope is the
      // contract the standby/CTO prompt tells the agent to fold in; the
      // wave id is included when wave admission succeeded.
      onTask: (task: InboxTask) => {
        const wave = task.waveId ? ` (wave ${task.waveId})` : "";
        pi.sendUserMessage(
          `[CTO-INBOX] New task via messenger (run \`${task.runId ?? "?"}\`)${wave}:\n${task.text}\n\n` +
            "Treat this as a /cto task — fold it into the active run (amend discipline: re-plan, " +
            "spawn leads in parallel, integration covers ALL teams).",
        );
      },
      // Wake on a user-initiated answer (reply / button) so the agent
      // reacts without waiting for the next checkpoint poll.
      onAnswer: (answer) => {
        pi.sendUserMessage(
          `[CTO-ANSWER] User answered escalation \`${answer.id}\` with: ${answer.answer}\n\n` +
            `Read \`.work-state/cto/${answer.id.split("/")[0] ?? "?"}/answers/${answer.id.replace(/[^a-zA-Z0-9-_]/g, "-")}.json\` ` +
            "and apply it now if the waiting team is still parked; otherwise treat it as advisory.",
        );
      },
    });
    dispatcherStopsByCwd.set(cwd, stopDispatcher);
  });
  pi.on("session_shutdown", (_event: unknown, ctx: unknown) => {
    if (!isMainSessionContext(ctx)) return;
    const cwd = resolveSessionCwd(ctx);
    if (!cwd) return;
    dispatcherStopsByCwd.get(cwd)?.();
    dispatcherStopsByCwd.delete(cwd);
  });
}

// ── cto-safety (br-zps.4, br-zps.5, br-zps.6) ──
export { MockEscalationAdapter, registerMockAdapter } from "./adapters/mock.js";
export * from "./lecture-acquisition/eval.js";
