/**
 * Messenger-channel mode detection + `ask` redirect gate.
 *
 * When a validated RW escalation channel (telegram, or a channel whose
 * adapter kind has inbound+outbound capabilities) is configured
 * (`.omp/escalation.json`), ALL user communication in a CTO run must go
 * through the messenger (outbox -> answers/), never through the interactive
 * `ask` tool. This module:
 *   - `channelMode(cwd)` — "telegram" | "http" | null (cached).
 *   - `createAskRedirectGate(resolveCwd, resolveRuntimeAccess)` — a
 *     `tool_call` hook that BLOCKS `ask` while a capability-validated RW
 *     primary AND an active CTO run exist; both providers are mandatory and
 *     are checked against the same immutable session root,
 *     returning the outbox contract as the reason (the LLM sees it and
 *     routes the question).
 *
 * The gate is deliberately scoped to active CTO runs: outside a run, normal
 * interactive work keeps `ask` working even in projects with a channel.
 * Terminal/RO-only modes keep `ask` as the fallback (no validated RW
 * primary -> no redirect). The gate validates the concrete adapter registry,
 * so a declared read-write channel must be both capability-compatible and
 * constructible; invalid marked primaries are surfaced as a blocked
 * configuration instead of silently falling back to interactive ask.
 */

import { PinnedProjectRoot, EscalationConfigError, resolveChannelProfile } from "@andvl1/omp-workflows-core";
import type { CtoRuntimeAccessFacade } from "@andvl1/omp-workflows-core/cto-runtime";
import { isBidirectionalChannel } from "./adapters/registry.js";

export type ChannelMode = "telegram" | "http" | null;

/** Resolve the configured channel mode through the authenticated facade. */
export function channelMode(cwd: string, runtimeAccess?: CtoRuntimeAccessFacade): ChannelMode {
  if (runtimeAccess) {
    try {
      for (const kind of ["telegram", "http"] as const) {
        const projections = runtimeAccess.resolveEscalationChannelConfigs(kind);
        if (Array.isArray(projections) && projections.some((projected) => projected?.adapter === kind)) return kind;
      }
      return null;
    } catch {
      return null;
    }
  }
  // Keep this read-only helper compatible for callers that only need a display
  // mode. The ask gate never uses this path: it requires the live facade above.
  const root = PinnedProjectRoot.open(cwd);
  if (!root) return null;
  try {
    // The legacy display helper intentionally keeps the old small bounded
    // config-read contract; the authenticated gate above uses the facade.
    root.readFile(".omp/escalation.json", { maxBytes: 4 * 1024 });
    const profile = resolveChannelProfile(root.canonical_root);
    return profile.adapter === "telegram" || profile.adapter === "http" ? profile.adapter : null;
  } catch {
    return null;
  } finally {
    root.close();
  }
}

/** Clear the cached channel mode (tests, config reloads). */
export function clearChannelCache(): void {
  // Facade reads are intentionally uncached so revocation is observed immediately.
}

export { isBidirectionalChannel } from "./adapters/registry.js";

/**
 * `tool_call` hook: block the `ask` tool when a capability-validated RW
 * primary is configured AND a CTO run is active. The `reason` is returned
 * to the LLM, which then writes the question to the outbox instead.
 */
export type CtoRuntimeAccessProvider = (cwd: string) => CtoRuntimeAccessFacade | undefined;
export type CtoSessionCwdResolver = (ctx: unknown) => string | undefined;

type AskRedirectResult = { block: boolean; reason: string } | undefined;
type AskRedirectContext = { readonly cwd?: unknown };

const ASK_ROOT_BLOCKED_REASON =
  "messenger-mode: the authoritative session root is unavailable or changed; ask is blocked until the active session is re-established.";
const ASK_AUTHORITY_UNAVAILABLE_REASON =
  "messenger-mode: canonical CTO delivery authority is unavailable or its active-run index proof needs recovery; ask is blocked until the runtime authority is re-established.";

function blockedAsk(reason = ASK_ROOT_BLOCKED_REASON): { block: true; reason: string } {
  return { block: true, reason };
}

function rawContextCwd(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const cwd = (ctx as AskRedirectContext).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

function samePinnedRoot(left: PinnedProjectRoot, right: PinnedProjectRoot): boolean {
  return left.canonical_root === right.canonical_root && left.dev === right.dev && left.ino === right.ino;
}

function isAuthorityUnavailable(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as { code?: unknown; status?: unknown; message?: unknown };
  if (record.code === "CTO_AUTHORITY_UNAVAILABLE" || record.code === "cto_authority_unavailable" || record.code === "authority_unavailable" || record.code === "runtime_access_invalid") return true;
  if (record.status === "authority_unavailable") return true;
  return typeof record.message === "string" && /(?:canonical )?CTO (?:delivery )?authority|active-run index proof|delivery index proof/i.test(record.message);
}

/**
 * `tool_call` hook: resolve the project only from the authoritative session
 * manager context, then validate the live runtime facade against that exact
 * immutable root before deciding whether `ask` may proceed. A missing or
 * contradictory root/facade is a security failure: terminal ask is blocked,
 * never silently allowed on an attacker-selected cwd.
 */
export function createAskRedirectGate(
  resolveCwd: CtoSessionCwdResolver,
  resolveRuntimeAccess: CtoRuntimeAccessProvider,
): (event: { toolName?: string }, ctx: unknown) => AskRedirectResult {
  return (event, ctx) => {
    if (event?.toolName !== "ask") return undefined;

    let authoritativeCwd: string | undefined;
    try {
      authoritativeCwd = resolveCwd(ctx);
    } catch {
      return blockedAsk();
    }
    if (!authoritativeCwd) return blockedAsk();

    const pinnedRoot = PinnedProjectRoot.open(authoritativeCwd);
    if (!pinnedRoot) return blockedAsk();
    let rawRoot: PinnedProjectRoot | null = null;
    try {
      if (!pinnedRoot.isStable()) return blockedAsk();
      const suppliedCwd = rawContextCwd(ctx);
      if (suppliedCwd !== undefined) {
        rawRoot = PinnedProjectRoot.open(suppliedCwd);
        if (!rawRoot || !samePinnedRoot(rawRoot, pinnedRoot)) return blockedAsk();
      }
      const canonicalRoot = pinnedRoot.canonical_root;
      let runtimeAccess: CtoRuntimeAccessFacade | undefined;
      try {
        runtimeAccess = resolveRuntimeAccess(authoritativeCwd);
      } catch (error) {
        if (isAuthorityUnavailable(error)) return blockedAsk(ASK_AUTHORITY_UNAVAILABLE_REASON);
        return blockedAsk();
      }
      if (!runtimeAccess) return blockedAsk();
      runtimeAccess.assertLive();
      runtimeAccess.assertProjectRoot(canonicalRoot);
      if (!pinnedRoot.isStable()) return blockedAsk();
      // Resolve active-run authority before channel construction. A corrupt or
      // missing delivery-index proof must never be hidden as a normal
      // no-active-run result by the channel resolver.
      let active: ReturnType<CtoRuntimeAccessFacade["findActiveRun"]>;
      try {
        active = runtimeAccess.findActiveRun();
      } catch (error) {
        if (isAuthorityUnavailable(error)) return blockedAsk(ASK_AUTHORITY_UNAVAILABLE_REASON);
        throw error;
      }
      if (isAuthorityUnavailable(active)) return blockedAsk(ASK_AUTHORITY_UNAVAILABLE_REASON);
      runtimeAccess.assertLive();
      runtimeAccess.assertProjectRoot(canonicalRoot);
      if (!pinnedRoot.isStable()) return blockedAsk();
      if (!active) return undefined;
      if (!isBidirectionalChannel(canonicalRoot, undefined, pinnedRoot, runtimeAccess)) return undefined;
      runtimeAccess.assertLive();
      runtimeAccess.assertProjectRoot(canonicalRoot);
      if (!pinnedRoot.isStable()) return blockedAsk();
      return {
        block: true,
        reason:
          "messenger-mode: a bidirectional messenger channel is active in this CTO run. Do NOT use ask — " +
          "write the question as an escalation to `.work-state/cto/<runId>/outbox/<escId>.json` " +
          "(level question/decision, timeoutMs + default); the answer will land in `answers/<escId>.json` " +
          "and you pick it up at the next checkpoint.",
      };
    } catch (error) {
      if (isAuthorityUnavailable(error)) return blockedAsk(ASK_AUTHORITY_UNAVAILABLE_REASON);
      if (error instanceof EscalationConfigError && error.code === "invalid_primary") {
        return blockedAsk(
          "messenger-mode: escalation channel configuration is blocked. Fix the explicitly marked " +
          "read-write primary before using ask or the outbox.",
        );
      }
      return blockedAsk();
    } finally {
      rawRoot?.close();
      pinnedRoot.close();
    }
  };
}
