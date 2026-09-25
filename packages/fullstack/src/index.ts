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
} from "@oh-my-pi/pi-coding-agent";
import {
  createWorkflowSessionController,
  createWorkflowToolAdapter,
  registerTeamWorkflow,
  readAgentMapping,
  resolveActiveBranch,
  runTarget,
  suspendCtoSession,
  type CtoClaimScope,
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
import {
  createChannelSet,
  queueCtoDelivery,
  startChannelDispatcher,
  type DispatcherBinding,
  type InboxTask,
  type InboxWakeResult,
} from "./adapters/registry.js";
import { createCtoModeReminderHandler, type CtoReminderContext } from "./cto-mode-reminder.js";
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
import { createAskRedirectGate } from "./messenger-channel.js";
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
 * can leave the copied context value stale after a session move. A supplied
 * context cwd is therefore accepted only when it agrees with the manager;
 * process cwd is never substituted.
 */
export function resolveSessionCwd(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
  const objectContext = ctx as { cwd?: unknown; sessionManager?: unknown };
  const manager = objectContext.sessionManager;
  if (manager !== undefined) {
    if (!manager || typeof manager !== "object" || !("getCwd" in manager) || typeof manager.getCwd !== "function") return undefined;
    try {
      const sessionCwd = manager.getCwd();
      if (typeof sessionCwd !== "string" || sessionCwd.length === 0) return undefined;
      if ("cwd" in objectContext && objectContext.cwd !== undefined) {
        if (typeof objectContext.cwd !== "string" || objectContext.cwd.length === 0) return undefined;
        if (resolve(objectContext.cwd) !== resolve(sessionCwd)) return undefined;
      }
      return sessionCwd;
    } catch {
      return undefined;
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
 * The dispatcher and workflow controller are scoped to one exact host
 * session. The manager object is part of that proof: two independent
 * sessions may report the same cwd and even the same session id without
 * being allowed to release or replace one another.
 */
const subagentTreeRef: { current: SubagentTreeController | null } = { current: null };
type SessionManagerIdentity = {
  getCwd: () => unknown;
  getSessionId: () => unknown;
  getSessionFile?: () => unknown;
};
type HostSessionIdentity = {
  manager?: object;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
};
type CapturedHostSession = HostSessionIdentity & { manager: object; mode: "tui" | "rpc"; hasUI: true };
type PrimaryHostSessionProfile =
  | CapturedHostSession
  | (HostSessionIdentity & { manager: object; mode: "headless"; hasUI: false });
type LifecycleIdentityPart = Partial<HostSessionIdentity>;
type LifecycleIdentityPartResult = { valid: true; identity?: LifecycleIdentityPart } | { valid: false };
const workflowSessionRef: { current: WorkflowSessionController | null } = { current: null };
const workflowSessionCapturedAtHostStart = { current: false };
const capturedHostSessionRef: { current: CapturedHostSession | null } = { current: null };
/** Latest primary host profile; headless marks an explicit fail-closed boundary. */
const primaryHostSessionRef: { current: PrimaryHostSessionProfile | null } = { current: null };
type ActiveDispatcher = CapturedHostSession & { stop: () => void };
const activeDispatcherRef: { current: ActiveDispatcher | null } = { current: null };

function sessionManagerFromContext(ctx: unknown): (SessionManagerIdentity & object) | undefined {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
  try {
    if (!("sessionManager" in ctx)) return undefined;
    const candidate = ctx.sessionManager;
    if (!candidate || typeof candidate !== "object") return undefined;
    const manager = candidate as SessionManagerIdentity;
    return typeof manager.getCwd === "function" && typeof manager.getSessionId === "function"
      ? candidate as SessionManagerIdentity & object
      : undefined;
  } catch {
    return undefined;
  }
}

type ExplicitStringField = { valid: boolean; value?: string };

function explicitStringField(value: Record<string, unknown>, key: string): ExplicitStringField {
  if (!(key in value) || value[key] === undefined) return { valid: true };
  return typeof value[key] === "string" && value[key].length > 0
    ? { valid: true, value: value[key] as string }
    : { valid: false };
}

function aliasedStringField(value: Record<string, unknown>, first: string, second: string): ExplicitStringField {
  const left = explicitStringField(value, first);
  const right = explicitStringField(value, second);
  if (!left.valid || !right.valid) return { valid: false };
  if (left.value !== undefined && right.value !== undefined && left.value !== right.value) return { valid: false };
  return { valid: true, value: left.value ?? right.value };
}

function samePath(left: string, right: string): boolean {
  try {
    return resolve(left) === resolve(right);
  } catch {
    return false;
  }
}
function aliasedPathField(value: Record<string, unknown>, first: string, second: string): ExplicitStringField {
  const left = explicitStringField(value, first);
  const right = explicitStringField(value, second);
  if (!left.valid || !right.valid) return { valid: false };
  if (left.value !== undefined && right.value !== undefined && !samePath(left.value, right.value)) return { valid: false };
  return { valid: true, value: left.value ?? right.value };
}

function explicitSessionFile(value: Record<string, unknown>, manager: SessionManagerIdentity): ExplicitStringField {
  const supplied = aliasedPathField(value, "sessionFile", "session_file");
  if (!supplied.valid) return supplied;
  if (typeof manager.getSessionFile !== "function") return supplied;
  let managerFile: unknown;
  try {
    managerFile = manager.getSessionFile();
  } catch {
    return supplied.value === undefined ? { valid: true } : { valid: false };
  }
  if (typeof managerFile !== "string" || managerFile.length === 0) {
    return supplied.value === undefined ? { valid: true } : { valid: false };
  }
  if (supplied.value !== undefined && !samePath(supplied.value, managerFile)) return { valid: false };
  return { valid: true, value: managerFile };
}

function hasUntrustedExplicitActor(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object") return false;
  try {
    const value = ctx as Record<string, unknown>;
    if (!("actor" in value)) return false;
    return value.actor !== undefined && value.actor !== "orchestrator";
  } catch {
    return true;
  }
}

function authoritativeHostSession(ctx: unknown): HostSessionIdentity | undefined {
  const manager = sessionManagerFromContext(ctx);
  if (!manager || !ctx || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
  try {
    const value = ctx as Record<string, unknown>;
    const cwd = manager.getCwd();
    const sessionId = manager.getSessionId();
    if (typeof cwd !== "string" || cwd.length === 0 || typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    const suppliedCwd = explicitStringField(value, "cwd");
    const suppliedId = aliasedStringField(value, "session_id", "sessionId");
    const suppliedFile = explicitSessionFile(value, manager);
    if (!suppliedCwd.valid || !suppliedId.valid || !suppliedFile.valid) return undefined;
    if (suppliedCwd.value !== undefined && !samePath(suppliedCwd.value, cwd)) return undefined;
    if (suppliedId.value !== undefined && suppliedId.value !== sessionId) return undefined;
    return {
      manager,
      cwd,
      sessionId,
      ...(suppliedFile.value !== undefined ? { sessionFile: suppliedFile.value } : {}),
    };
  } catch {
    return undefined;
  }
}
 
function lifecycleIdentityPart(value: unknown): LifecycleIdentityPartResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: true };
  try {
    const objectValue = value as Record<string, unknown>;
    const hasManager = "sessionManager" in objectValue && objectValue.sessionManager !== undefined;
    const manager = sessionManagerFromContext(value);
    if (hasManager && !manager) return { valid: false };
    if (manager) {
      const authoritative = authoritativeHostSession(value);
      if (!authoritative) return { valid: false };
      return { valid: true, identity: authoritative };
    }
    const cwd = explicitStringField(objectValue, "cwd");
    const sessionId = aliasedStringField(objectValue, "session_id", "sessionId");
    const sessionFile = aliasedPathField(objectValue, "sessionFile", "session_file");
    if (!cwd.valid || !sessionId.valid || !sessionFile.valid) return { valid: false };
    return cwd.value || sessionId.value || sessionFile.value ? {
      valid: true,
      identity: {
        ...(cwd.value ? { cwd: cwd.value } : {}),
        ...(sessionId.value ? { sessionId: sessionId.value } : {}),
        ...(sessionFile.value ? { sessionFile: sessionFile.value } : {}),
      },
    } : { valid: true };
  } catch {
    return { valid: false };
  }
}

function lifecycleIdentity(event: unknown, ctx: unknown): HostSessionIdentity | undefined {
  if (hasUntrustedExplicitActor(event) || hasUntrustedExplicitActor(ctx)) return undefined;
  const eventPart = lifecycleIdentityPart(event);
  const contextPart = lifecycleIdentityPart(ctx);
  if (!eventPart.valid || !contextPart.valid) return undefined;
  const eventIdentity = eventPart.identity;
  const contextIdentity = contextPart.identity;
  if (eventIdentity?.sessionId && contextIdentity?.sessionId && eventIdentity.sessionId !== contextIdentity.sessionId) return undefined;
  if (eventIdentity?.cwd && contextIdentity?.cwd && !samePath(eventIdentity.cwd, contextIdentity.cwd)) return undefined;
  if (eventIdentity?.manager && contextIdentity?.manager && eventIdentity.manager !== contextIdentity.manager) return undefined;
  if (eventIdentity?.sessionFile && contextIdentity?.sessionFile && !samePath(eventIdentity.sessionFile, contextIdentity.sessionFile)) return undefined;
  const current = contextIdentity ?? eventIdentity;
  const cwd = current?.cwd;
  const sessionId = current?.sessionId;
  if (!cwd || !sessionId) return undefined;
  return {
    ...current,
    cwd,
    sessionId,
    ...(contextIdentity?.manager ?? eventIdentity?.manager ? { manager: contextIdentity?.manager ?? eventIdentity?.manager } : {}),
    ...(contextIdentity?.sessionFile ?? eventIdentity?.sessionFile
      ? { sessionFile: contextIdentity?.sessionFile ?? eventIdentity?.sessionFile }
      : {}),
  };
}

function lifecycleEventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function eventMatches(event: unknown, expected: string, requireType = false): boolean {
  const type = lifecycleEventType(event);
  return type === undefined ? !requireType : type === expected;
}

function sameHostSessionIdentity(left: HostSessionIdentity, right: HostSessionIdentity): boolean {
  try {
    if (left.sessionId !== right.sessionId || resolve(left.cwd) !== resolve(right.cwd)) return false;
  } catch {
    return false;
  }
  if (left.manager !== right.manager) return false;
  const leftFile = left.sessionFile;
  const rightFile = right.sessionFile;
  if (leftFile === undefined || rightFile === undefined) return leftFile === rightFile;
  return samePath(leftFile, rightFile);
}

function sameCapturedHostSession(captured: CapturedHostSession, current: HostSessionIdentity): boolean {
  return current.manager === captured.manager && sameHostSessionIdentity(captured, current);
}


/**
 * A same-identity headless session_start is an explicit fail-closed
 * boundary. It revokes interactive authority for the moment, but MUST NOT
 * suspend or release the retained CTO claim or discard the captured
 * controller. Only a verified interactive shutdown or replacement may do
 * that.
 */
function invalidateHeadlessHostSession(authoritative: HostSessionIdentity): void {
  const current = primaryHostSessionRef.current;
  if (!current || current.mode === "headless" || !sameHostSessionIdentity(current, authoritative)) return;
  primaryHostSessionRef.current = { ...authoritative, manager: authoritative.manager!, mode: "headless", hasUI: false };
}

function observePrimaryHostSession(ctx: unknown): void {
  const authoritative = authoritativeHostSession(ctx);
  if (!authoritative) return;
  const current = primaryHostSessionRef.current;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  const headless = value.hasUI === false;
  const mode = value.mode === "tui" || value.mode === "rpc" ? value.mode : undefined;
  if (current && sameHostSessionIdentity(current, authoritative)) {
    if (headless) {
      invalidateHeadlessHostSession(authoritative);
      return;
    }
    if (value.hasUI === true && mode !== undefined) {
      primaryHostSessionRef.current = {
        ...authoritative,
        manager: authoritative.manager!,
        mode,
        hasUI: true,
      };
    }
    return;
  }
  // A different manager is an independent host session, not a replacement.
  if (current || value.hasUI !== true || mode === undefined) return;
  primaryHostSessionRef.current = {
    ...authoritative,
    manager: authoritative.manager!,
    mode,
    hasUI: true,
  };
}

function clearPrimaryHostSession(ctx: unknown): void {
  const authoritative = authoritativeHostSession(ctx);
  const current = primaryHostSessionRef.current;
  if (authoritative && current && sameHostSessionIdentity(current, authoritative)
    && current.manager === authoritative.manager) {
    primaryHostSessionRef.current = null;
  }
}

function trustedHostSession(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object" || hasUntrustedExplicitActor(ctx)) return false;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  return value.hasUI === true
    && (value.mode === "tui" || value.mode === "rpc")
    && authoritativeHostSession(ctx) !== undefined;
}

function captureHostSession(ctx: unknown, authoritative: HostSessionIdentity): CapturedHostSession | undefined {
  if (!ctx || typeof ctx !== "object" || !authoritative.manager) return undefined;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  if (value.hasUI !== true || (value.mode !== "tui" && value.mode !== "rpc")) return undefined;
  return {
    ...authoritative,
    manager: authoritative.manager,
    mode: value.mode,
    hasUI: true,
  };
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

function exactCapturedInteractiveContext(ctx: unknown): CapturedHostSession | undefined {
  if (!trustedHostSession(ctx)) return undefined;
  const authoritative = authoritativeHostSession(ctx);
  const captured = capturedHostSessionRef.current;
  if (!authoritative || !captured || !sameCapturedHostSession(captured, authoritative)) return undefined;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  return value.mode === captured.mode && value.hasUI === true ? captured : undefined;
}

function sessionSwitchForCapturedHost(event: unknown, ctx: unknown): {
  controller: WorkflowSessionController;
  captured: CapturedHostSession;
  current: HostSessionIdentity;
} | undefined {
  if (lifecycleEventType(event) !== "session_switch") return undefined;
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const value = event as { reason?: unknown; previousSessionFile?: unknown };
  if (value.reason !== "new" && value.reason !== "resume" && value.reason !== "fork") return undefined;
  if (value.previousSessionFile !== undefined
    && (typeof value.previousSessionFile !== "string" || value.previousSessionFile.length === 0)) return undefined;
  const captured = capturedHostSessionRef.current;
  const controller = workflowSessionRef.current;
  const current = authoritativeHostSession(ctx);
  const identity = lifecycleIdentity(event, ctx);
  if (
    !captured
    || !controller
    || !current
    || !identity
    || !trustedHostSession(ctx)
    || current.manager !== captured.manager
    || !sameHostSessionIdentity(current, identity)
  ) return undefined;
  if (current.sessionId === captured.sessionId || !samePath(current.cwd, captured.cwd)) return undefined;
  const currentProfile = ctx as { mode?: unknown; hasUI?: unknown };
  if (currentProfile.mode !== captured.mode || currentProfile.hasUI !== true) return undefined;
  let hasActiveClaim = false;
  try {
    hasActiveClaim = controller.activeCtoClaim() !== undefined || controller.activeClaimRunId() !== undefined;
  } catch {
    return undefined;
  }
  const previousSessionFile = value.previousSessionFile;
  // A captured owner requires a durable old-session proof. The manager
  // object, changed live id, and previousSessionFile tie this callback to
  // the captured pre-switch session before any release or reset.
  if (captured.sessionFile !== undefined) {
    if (typeof previousSessionFile !== "string" || previousSessionFile.length === 0) return undefined;
    if (!samePath(captured.sessionFile, previousSessionFile)) return undefined;
  } else if (hasActiveClaim) {
    return undefined;
  }
  return { controller, captured, current };
}

/**
 * Bind the shared controller before core command/tool registration sees a
 * session_start event. A later independent manager is not a replacement:
 * only the pinned host's session_switch event may hand over this binding.
 */
function bindWorkflowSession(ctx: unknown): void {
  if (!trustedHostSession(ctx)) return;
  const authoritative = authoritativeHostSession(ctx);
  if (!authoritative) return;
  const existing = workflowSessionRef.current;
  if (existing) {
    const captured = capturedHostSessionRef.current;
    if (captured && sameCapturedHostSession(captured, authoritative)) {
      const refreshed = captureHostSession(ctx, authoritative);
      if (refreshed) {
        capturedHostSessionRef.current = refreshed;
        primaryHostSessionRef.current = refreshed;
      }
      return;
    }
    // session_start from another manager, cwd, or id is independent. It must
    // not suspend, reset, or release the resident controller.
    return;
  }
  const controller = createWorkflowSession(authoritative.cwd, authoritative.sessionId);
  const captured = controller ? captureHostSession(ctx, authoritative) : undefined;
  if (!controller || !captured) return;
  workflowSessionRef.current = controller;
  workflowSessionCapturedAtHostStart.current = true;
  capturedHostSessionRef.current = captured;
  // This ingress runs before core's lifecycle handler, so the first tool call
  // after session_start already has the exact manager/profile proof.
  primaryHostSessionRef.current = captured;
}

function stopDispatcherForHost(captured: CapturedHostSession): boolean {
  const active = activeDispatcherRef.current;
  if (!active) return true;
  if (!sameCapturedHostSession(captured, active)) return false;
  try {
    active.stop();
    activeDispatcherRef.current = null;
    return true;
  } catch {
    return false;
  }
}

function switchStillOwnsOldBinding(
  transition: { controller: WorkflowSessionController; captured: CapturedHostSession; current: HostSessionIdentity },
  event: unknown,
  ctx: unknown,
): boolean {
  const authoritative = authoritativeHostSession(ctx);
  const identity = lifecycleIdentity(event, ctx);
  return workflowSessionRef.current === transition.controller
    && capturedHostSessionRef.current === transition.captured
    && trustedHostSession(ctx)
    && authoritative !== undefined
    && identity !== undefined
    && sameHostSessionIdentity(authoritative, transition.current)
    && sameHostSessionIdentity(identity, transition.current);
}

function handleWorkflowSessionSwitch(event: unknown, ctx: unknown): void {
  const transition = sessionSwitchForCapturedHost(event, ctx);
  if (!transition) return;
  try {
    if (transition.controller.activeCtoClaim()) {
      // The domain helper performs the claim CAS/journal release and clears
      // the old controller token only after a successful suspension.
      suspendCtoSession(transition.controller, "session-replacement");
    } else {
      transition.controller.release("host-session-replaced");
    }
  } catch {
    // Keep the old binding and dispatcher on any failed suspension/release.
    return;
  }
  if (!switchStillOwnsOldBinding(transition, event, ctx)) return;
  if (!stopDispatcherForHost(transition.captured)) return;
  if (!switchStillOwnsOldBinding(transition, event, ctx)) return;
  const nextController = createWorkflowSession(transition.current.cwd, transition.current.sessionId);
  const nextCaptured = nextController ? captureHostSession(ctx, transition.current) : undefined;
  if (!switchStillOwnsOldBinding(transition, event, ctx)) return;
  workflowSessionRef.current = nextController ?? null;
  workflowSessionCapturedAtHostStart.current = nextController !== undefined && nextCaptured !== undefined;
  capturedHostSessionRef.current = nextCaptured ?? null;
  primaryHostSessionRef.current = nextCaptured ?? null;
}

function verifiedOwnerLifecycle(
  event: unknown,
  ctx: unknown,
  expectedEvent: "session_stop" | "session_shutdown",
): CapturedHostSession | undefined {
  if (!eventMatches(event, expectedEvent)) return undefined;
  const captured = capturedHostSessionRef.current;
  const authoritative = authoritativeHostSession(ctx);
  const identity = lifecycleIdentity(event, ctx);
  if (
    !captured
    || !authoritative
    || !identity
    || !trustedHostSession(ctx)
    || !sameCapturedHostSession(captured, authoritative)
    || !sameCapturedHostSession(captured, identity)
  ) return undefined;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  return value.mode === captured.mode && value.hasUI === true ? captured : undefined;
}

function releaseWorkflowSession(event: unknown, ctx: unknown, teardown: boolean): void {
  const captured = verifiedOwnerLifecycle(event, ctx, teardown ? "session_shutdown" : "session_stop");
  if (!captured) return;
  const controller = workflowSessionRef.current;
  if (!controller) {
    if (teardown && stopDispatcherForHost(captured)
      && capturedHostSessionRef.current === captured
      && workflowSessionRef.current === null) {
      workflowSessionCapturedAtHostStart.current = false;
      capturedHostSessionRef.current = null;
      clearPrimaryHostSession(ctx);
    }
    return;
  }
  try {
    const controllerContext = controller.context();
    if (
      controllerContext.session_id !== captured.sessionId
      || !samePath(controllerContext.worktree, captured.cwd)
    ) return;
    const ctoClaim = controller.activeCtoClaim();
    if (!teardown) {
      // A turn-level stop is not a host teardown. Resident CTO ownership and
      // its dispatcher remain bound; ordinary workflow ownership may release.
      if (!ctoClaim) controller.release("host-session-stop");
      return;
    }
    if (ctoClaim) {
      suspendCtoSession(controller, "session-shutdown");
    } else {
      controller.release("host-session-shutdown");
    }
    if (workflowSessionRef.current !== controller || capturedHostSessionRef.current !== captured) return;
    if (!stopDispatcherForHost(captured)) return;
    if (workflowSessionRef.current !== controller || capturedHostSessionRef.current !== captured) return;
    workflowSessionRef.current = null;
    workflowSessionCapturedAtHostStart.current = false;
    capturedHostSessionRef.current = null;
    clearPrimaryHostSession(ctx);
  } catch {
    // Preserve the controller, claim, and dispatcher on a failed domain CAS.
  }
}

/**
 * Resolve the narrow orchestrator capability for a raw `tool_call`. OMP
 * 18.2.2 omits actor/hasUI on this event, so admission is based only on the
 * already captured interactive host profile plus the exact manager identity.
 */
function resolveFullstackTrustedToolCallActor(
  ctx: unknown,
  cwd: string,
  runId: string | undefined,
): TrustedToolCallResolution | undefined {
  if (!ctx || typeof ctx !== "object" || hasUntrustedExplicitActor(ctx)) return undefined;
  const captured = capturedHostSessionRef.current;
  const primary = primaryHostSessionRef.current;
  const controller = workflowSessionRef.current;
  const authoritative = authoritativeHostSession(ctx);
  if (
    !workflowSessionCapturedAtHostStart.current
    || !captured
    || !primary
    || primary.mode === "headless"
    || !controller
    || primary.manager !== captured.manager
    || !sameHostSessionIdentity(primary, captured)
    || !authoritative
    || !sameCapturedHostSession(captured, authoritative)
    || resolve(cwd) !== resolve(captured.cwd)
    || !toolCallProfileMatches(ctx, captured)
  ) return undefined;
  try {
    const controllerContext = controller.context();
    if (
      controllerContext.session_id !== captured.sessionId
      || resolve(controllerContext.worktree) !== resolve(captured.cwd)
    ) return undefined;

    // CTO authority is a distinct scope owned by the shared controller. An
    // ordinary selected run or explicit target is unrelated and MUST NOT gate
    // or downgrade a valid CTO claim.
    const ctoClaim = controller.activeCtoClaim();
    if (ctoClaim) {
      return {
        kind: "authenticated-interactive-host-cto",
        run_id: ctoClaim.run_id,
        ownership_epoch: ctoClaim.ownership_epoch,
      };
    }

    // Ordinary workflow authority retains the existing selected-run and
    // execution-claim checks.
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

function toolCallProfileMatches(ctx: unknown, captured: CapturedHostSession): boolean {
  if (!ctx || typeof ctx !== "object") return false;
  const value = ctx as { mode?: unknown; hasUI?: unknown };
  if (value.mode !== undefined && value.mode !== captured.mode) return false;
  // Raw tool callbacks may omit the profile fields entirely. An explicit
  // headless marker is contradictory to the captured interactive proof.
  return value.hasUI === undefined || value.hasUI === true;
}

type CtoClaimResolution = { claim?: CtoClaimScope; stale: boolean; error?: unknown };

function resolveCtoClaimForHost(captured: CapturedHostSession): CtoClaimResolution {
  const primary = primaryHostSessionRef.current;
  const controller = workflowSessionRef.current;
  if (
    !primary
    || primary.mode === "headless"
    || !controller
    || primary.manager !== captured.manager
    || !sameHostSessionIdentity(primary, captured)
  ) return { stale: false };
  try {
    const controllerContext = controller.context();
    if (
      controllerContext.session_id !== captured.sessionId
      || resolve(controllerContext.worktree) !== resolve(captured.cwd)
    ) return { stale: false };
    return { claim: controller.activeCtoClaim(), stale: false };
  } catch (error) {
    // A bound but unverifiable private token is typed refusal, not ordinary
    // absence. Callers that resolve authority fail closed; dispatcher startup
    // additionally refuses to create a new side effect for this binding.
    return { stale: true, error };
  }
}

function currentCtoClaimForHost(captured: CapturedHostSession): CtoClaimScope | undefined {
  const resolution = resolveCtoClaimForHost(captured);
  if (resolution.error !== undefined) throw resolution.error;
  return resolution.claim;
}

function dispatcherBindingFor(captured: CapturedHostSession): DispatcherBinding {
  return {
    session_id: captured.sessionId,
    getClaim: () => currentCtoClaimForHost(captured),
  };
}

/**
 * Shared accessor passed to commands, tools, and core hooks. The lifecycle
 * ingress is the only authority allowed to create, replace, or capture the
 * controller; this accessor only returns an already-captured exact binding.
 */
export function getFullstackWorkflowSessionController(ctx: unknown, cwd: string): WorkflowSessionController | undefined {
  const authoritative = authoritativeHostSession(ctx);
  const captured = capturedHostSessionRef.current;
  const primary = primaryHostSessionRef.current;
  const controller = workflowSessionRef.current;
  if (
    hasUntrustedExplicitActor(ctx)
    || !workflowSessionCapturedAtHostStart.current
    || !authoritative
    || !captured
    || !primary
    || primary.mode === "headless"
    || !controller
    || primary.manager !== captured.manager
    || !sameHostSessionIdentity(primary, captured)
    || !sameCapturedHostSession(captured, authoritative)
    || resolve(authoritative.cwd) !== resolve(cwd)
  ) return undefined;
  const value = ctx && typeof ctx === "object" ? ctx as { mode?: unknown; hasUI?: unknown } : {};
  if (value.mode !== captured.mode || value.hasUI !== true) return undefined;
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
 * through the verified session_switch ingress.
 */
function getFullstackRawWorkflowSessionController(
  ctx: unknown,
  cwd: string,
): WorkflowSessionController | undefined {
  const authoritative = authoritativeHostSession(ctx);
  const captured = capturedHostSessionRef.current;
  const primary = primaryHostSessionRef.current;
  const controller = workflowSessionRef.current;
  if (
    hasUntrustedExplicitActor(ctx)
    || !authoritative
    || !captured
    || !primary
    || primary.mode === "headless"
    || !controller
    || primary.manager !== captured.manager
    || !sameHostSessionIdentity(primary, captured)
    || !sameCapturedHostSession(captured, authoritative)
    || resolve(authoritative.cwd) !== resolve(cwd)
    || !toolCallProfileMatches(ctx, captured)
  ) return undefined;
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
  // The manager/profile proof is mandatory; there is no managerless TUI
  // fallback. RPC tool callbacks may omit hasUI, but remain manager-bound.
  return getFullstackRawWorkflowSessionController(ctx, cwd);
}

function currentCtoClaimForContext(ctx: unknown): CtoClaimScope | undefined {
  const cwd = resolveSessionCwd(ctx);
  if (!cwd) return undefined;
  return getFullstackWorkflowToolSessionController(ctx, cwd)?.activeCtoClaim();
}

function exactLifecycleContext(event: unknown, ctx: unknown): boolean {
  if (!eventMatches(event, "session_start")) return false;
  const identity = lifecycleIdentity(event, ctx);
  const authoritative = authoritativeHostSession(ctx);
  return Boolean(identity && authoritative && sameHostSessionIdentity(identity, authoritative));
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
  // OMP 18.2.2 mutates this same manager's current session id and emits
  // session_switch for /new and /resume; session_start is not a replacement.
  pi.on("session_switch", (event: unknown, ctx: unknown) => handleWorkflowSessionSwitch(event, ctx));
  pi.on("session_stop", (event: unknown, ctx: unknown) => releaseWorkflowSession(event, ctx, false));
  pi.on("session_shutdown", (event: unknown, ctx: unknown) => releaseWorkflowSession(event, ctx, true));
}


/**
 * Session-level main-session classification for fullstack-owned event
 * surfaces (session_start/session_shutdown, the messenger dispatcher,
 * widget binding). The installed host derives these event contexts from the
 * extension runner's UI context, so trusted RPC main sessions report
 * hasUI=true here. Task subagents run with `hasUI: false` and load the same
 * extension; only the interactive main session may own the product messenger
 * dispatcher, otherwise every lead/worker creates another getUpdates consumer
 * with its own offset. Unknown contexts are treated as main for compatibility
 * with older OMP/test runtimes that did not expose `hasUI` on session_start;
 * raw tool calls still require the captured manager/profile proof above.
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
function startDispatcherForHost(pi: ExtensionAPI, event: unknown, ctx: unknown, expectedEvent: "session_start" | "session_switch"): void {
  if (!eventMatches(event, expectedEvent, expectedEvent === "session_switch")) return;
  const identity = lifecycleIdentity(event, ctx);
  const authoritative = authoritativeHostSession(ctx);
  if (!identity || !authoritative || !sameHostSessionIdentity(identity, authoritative)) return;
  const captured = exactCapturedInteractiveContext(ctx);
  if (!captured || !workflowSessionRef.current) return;
  const active = activeDispatcherRef.current;
  if (active) {
    // A second manager/session must never stop or replace the resident
    // dispatcher. The verified switch path stops the old one first.
    if (sameCapturedHostSession(captured, active)) return;
    return;
  }
  const claimResolution = resolveCtoClaimForHost(captured);
  if (claimResolution.stale) return;
  const channelSet = createChannelSet(captured.cwd);
  if (channelSet.profiles.length === 0) return;
  const binding = dispatcherBindingFor(captured);
  const initialClaim = claimResolution.claim;
  if (channelSet.profile.direction === "rw" && initialClaim) {
    queueCtoDelivery(captured.cwd, initialClaim.run_id, {
      id: `${initialClaim.run_id}/system/ack/${Date.now()}`,
      level: "question",
      title: "CTO online",
      body: `resident run ${initialClaim.run_id} online (wave admission + outbox delivery active)`,
      intent: "ack",
      target: channelSet.profile.ackTarget,
    });
  }
  const stop = startChannelDispatcher(captured.cwd, channelSet, 10_000, {
    binding,
    // Wake the CTO session on an inbound task: idle starts a turn,
    // streaming queues as steer. The [CTO-INBOX] envelope is the
    // contract the CTO prompt tells the agent to fold in; the wave id is
    // included when wave admission succeeded.
    onTask: (task: InboxTask): InboxWakeResult => {
      const claim = binding.getClaim();
      if (!claim || task.runId !== claim.run_id) return "rejected";
      const wave = task.waveId ? ` (wave ${task.waveId})` : "";
      try {
        pi.sendUserMessage(
          `[CTO-INBOX] New task via messenger (run \`${task.runId}\`)${wave}:\n${task.text}\n\n` +
            "Treat this as a /cto task — fold it into the active run (amend discipline: re-plan, " +
            "spawn leads in parallel, integration covers ALL teams).",
        );
        return "accepted";
      } catch {
        // The host may have accepted the send before throwing. Keep the
        // durable inbox record and make no admission ACK or retry claim.
        return "unknown";
      }
    },
    // Wake on a user-initiated answer (reply / button) so the agent
    // reacts without waiting for the next checkpoint poll.
    onAnswer: (answer): InboxWakeResult => {
      const claim = binding.getClaim();
      if (!claim || answer.id.split("/")[0] !== claim.run_id) return "rejected";
      try {
        pi.sendUserMessage(
          `[CTO-ANSWER] User answered escalation \`${answer.id}\` with: ${answer.answer}\n\n` +
            `Read the durable answer records in \`.work-state/cto/${claim.run_id}/answers/\` ` +
            "and apply it now if the waiting team is still parked; otherwise treat it as advisory.",
        );
        return "accepted";
      } catch {
        // An exception after invocation is ambiguous; the answer file and
        // marker remain durable and no duplicate wake is promised.
        return "unknown";
      }
    },
  });
  activeDispatcherRef.current = { ...captured, stop };
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
    registerLectureAcquireTool(pi, z, {
      resolveSessionCwd,
      isMainSessionContext,
      getSessionController: getFullstackWorkflowToolSessionController,
    });
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

  // CTO-mode reminder — fires before EVERY LLM call. It may read persisted
  // plan text only after resolving the exact claim held by this session
  // controller; a latest-active run is never sufficient authority.
  const resolveCurrentCtoClaim = (ctx: CtoReminderContext): CtoClaimScope | undefined =>
    currentCtoClaimForContext(ctx);
  pi.on("context", createCtoModeReminderHandler(resolveCurrentCtoClaim));

  // Messenger-mode `ask` redirect: while a bidirectional channel (telegram)
  // AND this exact CTO claim exist, block the interactive `ask` tool so ALL
  // user communication goes through the messenger (outbox -> answers/).
  pi.on(
    "tool_call",
    createAskRedirectGate((ctx, cwd) => getFullstackWorkflowToolSessionController(ctx, cwd)?.activeCtoClaim()),
  );

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
  pi.on("session_start", (event: unknown, ctx: unknown) => {
    const cwd = resolveSessionCwd(ctx);
    if (!cwd) return;
    ensureCommandsForSession(cwd);
    if (isMainSessionContext(ctx)) {
      void refreshFullstackAgentMappings(cwd).catch(() => undefined);
    }
    const ui = extractUiFromContext(ctx);
    if (ui) subagentTreeRef.current = registerSubagentTree(pi, ui, cwd);
    startDispatcherForHost(pi, event, ctx, "session_start");
  });
  // The verified controller switch handler runs first and stops the old
  // dispatcher only after successful suspension; this callback starts the new
  // one under the new exact manager/session/profile binding.
  pi.on("session_switch", (event: unknown, ctx: unknown) => {
    startDispatcherForHost(pi, event, ctx, "session_switch");
  });
}

// ── cto-safety (br-zps.4, br-zps.5, br-zps.6) ──
export { MockEscalationAdapter, registerMockAdapter } from "./adapters/mock.js";
export * from "./lecture-acquisition/eval.js";
