import { validateWorkflowRunIdentity, type WorkflowRunIdentity } from "@andvl1/omp-workflows-core";
import type { ContextEvent, ContextEventResult } from "@oh-my-pi/pi-coding-agent";

export const CTO_MODE_MARKER = "[CTO-MODE-ACTIVE]";

export interface CtoRunRef {
  readonly run_identity: WorkflowRunIdentity;
  readonly task: string;
}

export type CtoRunResolver = (context: unknown) => CtoRunRef | undefined;

function runId(run: CtoRunRef): string {
  return run.run_identity.run_id;
}

export function buildCtoModeReminder(run: CtoRunRef): string {
  const checked = validateWorkflowRunIdentity(run.run_identity);
  if (!checked.ok) return "";
  const task = run.task && run.task !== runId(run) ? run.task.trim().slice(0, 80) : "";
  return [
    `${CTO_MODE_MARKER} A CTO sub-orchestration run is ACTIVE (run \`${runId(run)}\`${task ? `: ${task}` : ""}).`,
    "You are part of that run. DELEGATE, do not absorb:",
    "- Orchestrator (the CTO): decompose and delegate problems to teams via `task`; never code or patch yourself.",
    "- Team lead: every slice goes to a worker via `task`; escalate what you cannot decide to the CTO.",
    "- Worker: complete your single task; escalate blockers to your lead; never re-delegate or expand scope.",
    "The CTO is the main agent of this session and is never spawned as a nested task.",
  ].join("\n");
}

export function injectCtoModeReminder(messages: readonly unknown[], reminder: string): { messages: unknown[] } | undefined {
  if (!Array.isArray(messages) || messages.length === 0 || reminder.length === 0) return undefined;
  if (messages.some((message) => messageContainsText(message, CTO_MODE_MARKER))) return undefined;
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: `${reminder}\n` }], steering: true, timestamp: Date.now() },
      ...messages,
    ],
  };
}

function messageContainsText(message: unknown, needle: string): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "user") return false;
  if (typeof candidate.content === "string") return candidate.content.includes(needle);
  if (!Array.isArray(candidate.content)) return false;
  return candidate.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const textBlock = block as { type?: unknown; text?: unknown };
    return textBlock.type === "text" && typeof textBlock.text === "string" && textBlock.text.includes(needle);
  });
}

/**
 * Hook factory bound to a caller-owned run resolver. Resolver failures are
 * intentionally treated as unavailable; this hook never scans project state.
 */
export function createCtoModeReminderHandler(resolveRun: CtoRunResolver): (event: ContextEvent, context: unknown) => ContextEventResult | undefined {
  return (event, context) => {
    try {
      const run = resolveRun(context);
      if (!run) return undefined;
      const reminder = buildCtoModeReminder(run);
      const injected = injectCtoModeReminder(event.messages ?? [], reminder);
      return injected ? { messages: injected.messages as ContextEventResult["messages"] } : undefined;
    } catch {
      return undefined;
    }
  };
}
