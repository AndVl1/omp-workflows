/**
 * CTO nesting guard.
 *
 * `/cto` is a main-session control plane, not a child-agent role. The prompt
 * contract says the same thing, but this hook makes an explicit `task` call
 * targeting `cto` impossible even when a model ignores the prompt.
 */

interface ToolCallEvent {
  toolName?: string;
  input?: unknown;
}

export const NESTED_CTO_BLOCK_REASON =
  "cto-mode: nested CTO is disabled. Run `/cto` only in the main session as the single product assistant; " +
  "do not use task(agent: \"cto\" or \"@cto\"). Dispatch a concrete team lead/worker, or fold new work " +
  "into the active CTO run through its inbox/amend contract.";

const CTO_AGENT_NAMES: Record<string, true> = { cto: true, "@cto": true };

/** Block explicit task calls that select the CTO agent, including batches. */
export function ctoNestingGuard(event: ToolCallEvent): { block: true; reason: string } | undefined {
  if (event.toolName !== "task" || !containsCtoAgent(event.input)) return undefined;
  return { block: true, reason: NESTED_CTO_BLOCK_REASON };
}

function containsCtoAgent(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  if (typeof value.agent === "string" && CTO_AGENT_NAMES[value.agent.trim().toLowerCase()] === true) return true;
  if (!Array.isArray(value.tasks)) return false;
  return value.tasks.some((item) => {
    if (!item || typeof item !== "object") return false;
    const agent = (item as Record<string, unknown>).agent;
    return typeof agent === "string" && CTO_AGENT_NAMES[agent.trim().toLowerCase()] === true;
  });
}
