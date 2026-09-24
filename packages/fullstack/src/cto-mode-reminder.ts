/**
 * CTO-mode reminder — per-turn delegation reminder while a CTO run is active.
 *
 * The CTO is the MAIN AGENT of the session (the resident product assistant):
 * `/cto` runs in-session and is never dispatched via `task(agent=cto)` —
 * the reminder states that so neither the main agent nor a subagent spawns
 * a nested CTO.
 *
 * Wired as a `context` hook: it receives an exact CTO claim from the
 * bundle-owned session controller and prepends a short `steering` user
 * message restating the delegation contract (orchestrator -> teams, lead ->
 * workers, worker -> escalate up). A persisted latest-active run is never
 * sufficient authority for this reminder.
 *
 * The hook is intentionally fail-closed: a persisted latest-active run or
 * cwd-only lookup never authorizes a reminder. The invoking bundle supplies
 * the exact manager/session/profile claim for each callback.
 */

import { isCtoRunTerminal, readCtoState, type CtoClaimScope } from "@andvl1/omp-workflows-core";
import type {
  ContextEvent,
  ContextEventResult,
  ExtensionHandler,
} from "@oh-my-pi/pi-coding-agent";
/** Marker line used for dedupe and tests. Keep stable — it is user-visible. */
export const CTO_MODE_MARKER = "[CTO-MODE-ACTIVE]";

export interface CtoRunRef {
  runId: string;
  task: string;
}

export type CtoReminderContext = {
  cwd: string;
};

type CtoClaimResolver = (ctx: CtoReminderContext) => CtoClaimScope | undefined;

/**
 * Resolve the active CTO run only from an exact claim supplied by the
 * invoking callback's captured host context. There is intentionally no
 * latest-run or cwd-only fallback: a resolver must prove the manager,
 * session, and interactive profile before returning a claim.
 */
export function resolveActiveCtoRun(
  ctx: CtoReminderContext,
  resolveClaim?: CtoClaimResolver,
): CtoRunRef | null {
  try {
    if (!ctx || typeof ctx.cwd !== "string" || ctx.cwd.length === 0 || !resolveClaim) return null;
    const claim = resolveClaim(ctx);
    if (
      !claim
      || typeof claim.run_id !== "string"
      || claim.run_id.length === 0
      || typeof claim.ownership_epoch !== "string"
      || claim.ownership_epoch.length === 0
    ) return null;
    const state = readCtoState(claim.run_id, ctx.cwd);
    if (!state || state.id !== claim.run_id || isCtoRunTerminal(state)) return null;
    return { runId: claim.run_id, task: state.plan?.task ?? "" };
  } catch {
    return null;
  }
}
/**
 * Render the short, explicit delegation contract for the resident CTO.
 * Keep this text self-contained because it is injected into every context
 * turn while the exact claim remains active.
 */
export function buildCtoModeReminder(run: CtoRunRef): string {
  return [
    CTO_MODE_MARKER,
    "You are the MAIN AGENT — the resident CTO for this session.",
    `Active CTO run: ${run.runId} — ${run.task}`,
    "DELEGATE, do not absorb: orchestrator -> teams, lead -> workers, worker -> escalate up.",
    "As orchestrator, never code or patch yourself; delegate implementation and reviews.",
    "As lead, delegate every worker slice and escalate what you cannot decide to the CTO.",
    "As worker, complete only the assigned slice, never re-delegate, and escalate blockers to the lead.",
    "NEVER spawn a nested CTO with task(agent=cto) or task(agent=@cto).",
    "After each wave, return to standby and await the next explicit task.",
  ].join("\n");
}


/**
 * Prepend a steering reminder to a context snapshot. Returns the
 * `{ messages }` shape the `context` hook contract requires, or `undefined`
 * when the snapshot is unusable or the marker is already present (dedupe
 * against double-handler chains within one event — steering messages are
 * ephemeral per turn, so each turn re-injects).
 */
export function injectCtoModeReminder(
  messages: readonly unknown[],
  reminder: string,
): { messages: unknown[] } | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  for (const message of messages) {
    if (messageContainsText(message, CTO_MODE_MARKER)) return undefined;
  }
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

function messageContainsText(message: unknown, needle: string): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "user") return false;
  const content = candidate.content;
  if (typeof content === "string") return content.includes(needle);
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const textBlock = block as { type?: unknown; text?: unknown };
      return textBlock.type === "text" && typeof textBlock.text === "string" && textBlock.text.includes(needle);
    });
  }
  return false;
}

/**
 * Extension `context` hook factory. The handler resolves a run only from the
 * exact claim supplied by the fullstack session controller, then builds the
 * reminder and prepends it as a steering user message. Never throws.
 */
export function createCtoModeReminderHandler(
  resolveClaim?: CtoClaimResolver,
): ExtensionHandler<ContextEvent, ContextEventResult> {
  return (event, ctx) => {
    try {
      const run = resolveActiveCtoRun(ctx, resolveClaim);
      if (!run) return undefined;
      const injected = injectCtoModeReminder(event.messages ?? [], buildCtoModeReminder(run));
      if (!injected) return undefined;
      return { messages: injected.messages as ContextEventResult["messages"] };
    } catch {
      return undefined;
    }
  };
}
