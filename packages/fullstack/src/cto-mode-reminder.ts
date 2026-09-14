/**
 * CTO-mode reminder — per-turn delegation reminder while an explicitly
 * activated CTO session is active.
 *
 * Canonical project state is evidence, not an activation authority. A stale
 * or malicious `.work-state/cto/<run>/state.json` must never turn CTO mode on by
 * itself. The command adapter (explicit `/cto`) and the authenticated
 * messenger admission path call `activateCtoMode`; this in-memory registry is
 * intentionally lost on process/session restart, so a new `/cto` is required.
 *
 * The reminder carries only a bounded run identity and a fixed status. The
 * canonical `plan.task` is never copied into steering text: task text is
 * model/user data and must not become a per-turn instruction channel.
 */

import { PinnedProjectRoot } from "@andvl1/omp-workflows-core";
import type { CtoRuntimeAccessFacade } from "@andvl1/omp-workflows-core/cto-runtime";
import type { ContextEvent, ContextEventResult } from "@oh-my-pi/pi-coding-agent";

/** Marker line used for dedupe and tests. Keep stable — it is user-visible. */
export const CTO_MODE_MARKER = "[CTO-MODE-ACTIVE]";

export interface CtoRunRef {
  runId: string;
  status: "active" | "standby";
}

interface CtoActivation {
  cwd: string;
  canonicalRoot: string;
  rootDev: number;
  rootIno: number;
  sessionId: string;
  runId?: string;
  runtimeAccess?: CtoRuntimeAccessFacade;
}

const activations = new Map<string, CtoActivation>();
const runtimeAccesses = new Map<string, CtoRuntimeAccessFacade>();

/** Activation/runtime bindings are keyed by canonical root, never lexical aliases. */
function activationKey(canonicalRoot: string, sessionId: string): string {
  return `${canonicalRoot}\u0000${sessionId}`;
}

/** Open and pin the current project root for identity checks. */
function openActivationRoot(cwd: string): PinnedProjectRoot | null {
  try {
    return PinnedProjectRoot.open(cwd);
  } catch {
    return null;
  }
}

function dropActivation(key: string): void {
  // A poisoned access must never survive the activation that admitted it.
  activations.delete(key);
  runtimeAccesses.delete(key);
}

function dropMatchingActivations(cwd: string, sessionId: string): void {
  for (const [key, activation] of activations) {
    if (activation.sessionId !== sessionId) continue;
    if (activation.cwd === cwd || activation.canonicalRoot === cwd) dropActivation(key);
  }
  // A binding can exist briefly before activation (e.g. session_start), so
  // clean an exact canonical/raw key even when no activation record remains.
  runtimeAccesses.delete(activationKey(cwd, sessionId));
}

function activationMatchesRoot(activation: CtoActivation, pinnedRoot: PinnedProjectRoot): boolean {
  return pinnedRoot.canonical_root === activation.canonicalRoot
    && pinnedRoot.dev === activation.rootDev
    && pinnedRoot.ino === activation.rootIno;
}

/**
 * Bind one runtime facade to the canonical session root. Lexical aliases are
 * accepted only while they can be pinned safely; an unavailable/replaced path
 * cannot create a new authority binding.
 */
export function bindCtoRuntimeAccess(cwd: string, sessionId: string, runtimeAccess: CtoRuntimeAccessFacade): void {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof sessionId !== "string" || sessionId.length === 0 || !runtimeAccess) return;
  const pinnedRoot = openActivationRoot(cwd);
  if (!pinnedRoot) return;
  try {
    if (!pinnedRoot.isStable()) return;
    runtimeAccess.assertProjectRoot(pinnedRoot.canonical_root);
    if (!pinnedRoot.isStable()) return;
    runtimeAccesses.set(activationKey(pinnedRoot.canonical_root, sessionId), runtimeAccess);
  } catch {
    return;
  } finally {
    pinnedRoot.close();
  }
}

export function activateCtoMode(cwd: string, sessionId: string, runId?: string, runtimeAccess?: CtoRuntimeAccessFacade): void {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof sessionId !== "string" || sessionId.length === 0) return;
  const pinnedRoot = openActivationRoot(cwd);
  if (!pinnedRoot) return;
  try {
    if (!pinnedRoot.isStable()) return;
    const canonicalRoot = pinnedRoot.canonical_root;
    const key = activationKey(canonicalRoot, sessionId);
    let selectedAccess = runtimeAccess ?? runtimeAccesses.get(key);
    if (selectedAccess) {
      try { selectedAccess.assertProjectRoot(canonicalRoot); } catch { return; }
    }
    const activation: CtoActivation = {
      // Keep the admission spelling for cleanup when that alias later
      // disappears; authority and lookup use canonicalRoot below.
      cwd,
      canonicalRoot,
      rootDev: pinnedRoot.dev,
      rootIno: pinnedRoot.ino,
      sessionId,
      runtimeAccess: selectedAccess,
    };
    if (typeof runId === "string" && runId.length > 0) activation.runId = runId;
    activations.set(key, activation);
  } finally {
    pinnedRoot.close();
  }
}

/** Remove one session-local activation (session shutdown / explicit stop). */
export function deactivateCtoMode(cwd: string, sessionId: string): void {
  if (typeof cwd !== "string" || typeof sessionId !== "string") return;
  const pinnedRoot = openActivationRoot(cwd);
  if (!pinnedRoot) {
    // The canonical pathname may have disappeared. Remove only records for
    // this exact session and the stored spelling/root identity.
    dropMatchingActivations(cwd, sessionId);
    return;
  }
  try {
    const canonicalRoot = pinnedRoot.canonical_root;
    dropActivation(activationKey(canonicalRoot, sessionId));
    for (const [key, activation] of activations) {
      if (activation.sessionId === sessionId && activation.canonicalRoot === canonicalRoot) dropActivation(key);
    }
    runtimeAccesses.delete(activationKey(canonicalRoot, sessionId));
  } finally {
    pinnedRoot.close();
  }
}

/** Test and lifecycle helper; state is intentionally process-local only. */
export function clearCtoModeActivations(): void {
  activations.clear();
  runtimeAccesses.clear();
}

function safeOpaque(value: string, fallback: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/u.test(value) ? value : fallback;
}

/**
 * Resolve the authenticated active run through the main-session runtime
 * facade. The facade owns state/index validation; this module only retains
 * the session-local activation binding and formats the safe projection.
 */
export function resolveActiveCtoRun(cwd: string, sessionId?: string, runtimeAccess?: CtoRuntimeAccessFacade): CtoRunRef | null {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof sessionId !== "string" || sessionId.length === 0) return null;
  const pinnedRoot = openActivationRoot(cwd);
  if (!pinnedRoot) {
    dropMatchingActivations(cwd, sessionId);
    return null;
  }
  const key = activationKey(pinnedRoot.canonical_root, sessionId);
  const activation = activations.get(key);
  if (!activation) {
    pinnedRoot.close();
    return null;
  }
  const access = runtimeAccess ?? activation.runtimeAccess;
  if (!access) {
    pinnedRoot.close();
    return null;
  }
  try {
    if (!pinnedRoot.isStable() || !activationMatchesRoot(activation, pinnedRoot)) {
      dropActivation(key);
      return null;
    }
    try { access.assertProjectRoot(pinnedRoot.canonical_root); } catch {
      dropActivation(key);
      return null;
    }
    let active: ReturnType<CtoRuntimeAccessFacade["findActiveRun"]>;
    try {
      active = access.findActiveRun();
    } catch {
      // A closed/revoked facade is terminal for this exact canonical session;
      // do not leave either half of the binding available for later turns.
      dropActivation(key);
      return null;
    }
    if (!active || !pinnedRoot.isStable() || !isSafeOpaqueRunId(active.runId)) {
      if (!pinnedRoot.isStable()) dropActivation(key);
      return null;
    }
    if (activation.runId !== undefined && activation.runId !== active.runId) return null;
    activation.runId ??= active.runId;
    activations.set(key, activation);
    const state = active.state;
    return { runId: safeOpaque(active.runId, "active-run"), status: state.standby === true ? "standby" : "active" };
  } catch {
    // Includes facade errors and root races; always revoke both maps for this
    // exact key, even when the filesystem still reports a stable root.
    dropActivation(key);
    return null;
  } finally {
    pinnedRoot.close();
  }
}

function isSafeOpaqueRunId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}

function isPlainContextObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.prototype.toString.call(value) === "[object Object]";
  } catch {
    return false;
  }
}

function isSafeSessionCwd(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

/** Extract the canonical session cwd, preferring a callable session manager. */
function sessionCwdFromContext(event: unknown, ctx: unknown): string | undefined {
  const sources = [ctx, event];
  let managerSeen = false;
  // A supplied manager is authoritative even when malformed, unavailable, or
  // returning an unsafe cwd; never fall back to a stale raw context value.
  for (const source of sources) {
    if (!isPlainContextObject(source)) continue;
    let manager: unknown;
    try { manager = source.sessionManager; } catch { return undefined; }
    if (manager === undefined || manager === null) continue;
    managerSeen = true;
    if (!isPlainContextObject(manager)) return undefined;
    try {
      if (!("getCwd" in manager) || typeof manager.getCwd !== "function") return undefined;
      const cwd = manager.getCwd();
      return isSafeSessionCwd(cwd) ? cwd : undefined;
    } catch {
      return undefined;
    }
  }
  if (managerSeen) return undefined;
  for (const source of sources) {
    if (!isPlainContextObject(source)) continue;
    try {
      if (isSafeSessionCwd(source.cwd)) return source.cwd;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Extract the canonical session identity, preferring the session manager. */
export function sessionIdFromContext(event: unknown, ctx: unknown): string | undefined {
  let managerSeen = false;
  for (const source of [ctx, event]) {
    if (!isPlainContextObject(source)) continue;
    let manager: unknown;
    try { manager = source.sessionManager; } catch { return undefined; }
    if (manager === undefined || manager === null) continue;
    managerSeen = true;
    if (!isPlainContextObject(manager)) return undefined;
    try {
      if (!("getSessionId" in manager) || typeof manager.getSessionId !== "function") return undefined;
      const sessionId = manager.getSessionId();
      return isSafeSessionId(sessionId) ? sessionId : undefined;
    } catch {
      return undefined;
    }
  }
  if (managerSeen) return undefined;
  for (const source of [ctx, event]) {
    if (!isPlainContextObject(source)) continue;
    try {
      const sessionId = source.sessionId;
      if (isSafeSessionId(sessionId)) return sessionId;
      const session_id = source.session_id;
      if (isSafeSessionId(session_id)) return session_id;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Build the fixed delegation reminder. Canonical plan.task is deliberately absent. */
export function buildCtoModeReminder(run: CtoRunRef): string {
  const runId = safeOpaque(run.runId, "active-run");
  const status = run.status === "standby" ? "standby" : "active";
  return [
    `${CTO_MODE_MARKER} A CTO sub-orchestration run is ACTIVE in this workspace (run \`${runId}\`, status \`${status}\`).`,
    "You are part of that run. DELEGATE, do not absorb:",
    "- Orchestrator (the CTO): decompose and delegate problems to teams via `task`; never code or patch yourself.",
    "- Team lead: every slice goes to a worker via `task`; escalate what you cannot decide to the CTO.",
    "- Worker: complete your single task; escalate blockers to your lead; never re-delegate or expand scope.",
    "The CTO is THE MAIN AGENT of this session (the resident CTO) — never spawned: do not run",
    "`task(agent=cto)` / `task(agent=@cto)`; the role has no nested form. The CTO stays on-line",
    "after each wave and returns to standby (await the next `[CTO-INBOX]` task).",
  ].join("\n");
}

/** Prepend a steering user message for this event snapshot. */
export function injectCtoModeReminder(
  messages: readonly unknown[],
  reminder: string,
): { messages: unknown[] } | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `${reminder}\n` }],
        steering: true,
        timestamp: Date.now(),
      },
      ...messages,
    ],
  };
}

/**
 * Extension `context` hook factory. The hook is inert until the exact
 * session/cwd was explicitly activated in this process. Dedupe is scoped to
 * the event object identity owned by this handler; user message text is data,
 * never an authorization or suppression signal.
 */
export function createCtoModeReminderHandler(): (event: ContextEvent, ctx: { cwd?: string; sessionId?: string; session_id?: string; sessionManager?: unknown }) => ContextEventResult | undefined {
  const remindedEvents = new WeakSet<object>();
  return (event, ctx) => {
    try {
      if (remindedEvents.has(event)) return undefined;
      const cwd = sessionCwdFromContext(event, ctx);
      const sessionId = sessionIdFromContext(event, ctx);
      if (!cwd || !sessionId) return undefined;
      const run = resolveActiveCtoRun(cwd, sessionId);
      if (!run) return undefined;
      const injected = injectCtoModeReminder(event.messages ?? [], buildCtoModeReminder(run));
      if (!injected) return undefined;
      remindedEvents.add(event);
      return { messages: injected.messages as ContextEventResult["messages"] };
    } catch {
      return undefined;
    }
  };
}
