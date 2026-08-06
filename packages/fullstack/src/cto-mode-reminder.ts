/**
 * CTO-mode reminder — per-turn delegation reminder while a CTO run is active.
 *
 * The CTO is the MAIN AGENT of the session (the resident product assistant):
 * `/cto` runs in-session and is never dispatched via `task(agent=cto)` —
 * the reminder states that so neither the main agent nor a subagent spawns
 * a nested CTO.
 *
 * Wired as a `context` hook: that event fires before EVERY LLM call (main
 * session and subagents alike). When an active CTO run exists under
 * `.work-state/cto/` (detected via core `findActiveCtoRun`), the handler
 * prepends a short `steering` user message restating the delegation contract
 * (orchestrator -> teams, lead -> workers, worker -> escalate up). The harness
 * wraps steering messages for emphasis and consumes them per turn, so the
 * reminder is fresh in front of the model at the moment it is about to act —
 * including turns after compaction, where the /cto prompt has drifted.
 *
 * The mechanism was verified live (omp 17.2.8): `context` fires per turn, the
 * handler must return `{ messages: [...] }` (bare arrays are dropped), and a
 * `steering: true` user message reaches the model on every turn. Cost is one
 * short message per LLM call while a run is active; zero overhead otherwise
 * (one cached readdir per 10s when no run exists).
 */

import { findActiveCtoRun } from "@andvl1/omp-workflows-core";
import type { ContextEvent, ContextEventResult } from "@oh-my-pi/pi-coding-agent";

/** Marker line used for dedupe and tests. Keep stable — it is user-visible. */
export const CTO_MODE_MARKER = "[CTO-MODE-ACTIVE]";

const CACHE_TTL_MS = 10_000;

export interface CtoRunRef {
  runId: string;
  task: string;
}

interface CachedRef {
  at: number;
  run: CtoRunRef | null;
}

const cache = new Map<string, CachedRef>();

/**
 * Build the reminder text. Kept short (~90 tokens) because it is paid on
 * every LLM call while a run is active.
 */
export function buildCtoModeReminder(run: CtoRunRef): string {
  const task = run.task && run.task !== run.runId ? run.task.trim().slice(0, 80) : "";
  return [
    `${CTO_MODE_MARKER} A CTO sub-orchestration run is ACTIVE in this workspace (run \`${run.runId}\`${task ? `: ${task}` : ""}).`,
    "You are part of that run. DELEGATE, do not absorb:",
    "- Orchestrator (the CTO): decompose and delegate problems to teams via `task`; never code or patch yourself.",
    "- Team lead: every slice goes to a worker via `task`; escalate what you cannot decide to the CTO.",
    "- Worker: complete your single task; escalate blockers to your lead; never re-delegate or expand scope.",
    "The CTO is THE MAIN AGENT of this session (the resident CTO) — never spawned: do not run",
    "`task(agent=cto)` / `task(agent=@cto)`; the role has no nested form. The CTO stays on-line",
    "after each wave and returns to standby (await the next `[CTO-INBOX]` task).",
  ].join("\n");
}

/**
 * Resolve the active CTO run for a cwd. Cached briefly per cwd — the hook
 * fires per LLM call and must not do filesystem work each time. Returns null
 * on any error (the hook must never break the agent loop).
 */
export function resolveActiveCtoRun(cwd: string): CtoRunRef | null {
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.run;
  cache.set(cwd, { at: now, run: null });
  try {
    const active = findActiveCtoRun(cwd);
    const run: CtoRunRef | null = active
      ? { runId: active.runId, task: active.state.plan.task ?? "" }
      : null;
    cache.set(cwd, { at: now, run });
    return run;
  } catch {
    return null;
  }
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
 * Extension `context` hook factory. The handler resolves the active CTO run
 * (cached), builds the reminder and prepends it as a steering user message.
 * Never throws: any error silently skips injection so the agent loop is never
 * disturbed. Returns `undefined` when no CTO run is active.
 *
 * The `context` hook contract: return `{ messages }` (a bare array is
 * dropped by the harness) with the modified snapshot. Steering user messages
 * are wrapped for emphasis and consumed per turn, so each LLM call re-injects.
 */
export function createCtoModeReminderHandler(): (event: ContextEvent, ctx: { cwd: string }) => ContextEventResult | undefined {
  return (event, ctx) => {
    try {
      const run = resolveActiveCtoRun(ctx.cwd);
      if (!run) return undefined;
      const injected = injectCtoModeReminder(event.messages ?? [], buildCtoModeReminder(run));
      if (!injected) return undefined;
      return { messages: injected.messages as ContextEventResult["messages"] };
    } catch {
      return undefined;
    }
  };
}
