/**
 * CTO conditional dissent evaluation (architecture §4.11 — br-zps.10, team cto-quality).
 *
 * Dissent triggers ONLY on high-stakes, irreversible, decision-contradicting,
 * or budget-exceeding actions. Low-stakes reversible work proceeds with NO
 * dissent (no gate tax). Deterministic rule table:
 *
 *   1. No trigger (stakes low/medium, reversible true, no tag, budget not
 *      "exceeded")                    → { trigger: null, severity: "none",
 *                                         reason: "no dissent needed", escalate_to: null }
 *   2. stakes === "high"              → trigger "high_stakes", severity "blocking",
 *                                       escalate_to "cto"
 *   3. reversible === false           → trigger "irreversible", severity "blocking",
 *                                       escalate_to "cto" (fires regardless of stakes)
 *   4. contradicts_decision_tag non-empty after trim → trigger "contradicts_decision",
 *      severity "advisory", escalate_to "lead" (deliberate overrides of decision
 *      memory are surfaced, not hard-blocked)
 *   5. budget_status === "exceeded"   → trigger "budget_exceeded", severity "blocking",
 *                                       escalate_to "cto"
 *
 * Multiple triggers: severity = "blocking" if ANY active trigger is blocking,
 * else "advisory". escalate_to = highest-priority escalation among active
 * triggers (cto > lead). trigger = the single most severe active trigger with
 * precedence budget_exceeded > high_stakes > irreversible > contradicts_decision.
 * reason = one string listing EVERY active trigger with its cause, using
 * opts.action in the wording.
 */

import type { BudgetStatus, DissentEvaluation, DissentTrigger } from "./types.js";

/** Trigger precedence, lowest number wins: budget_exceeded > high_stakes > irreversible > contradicts_decision. */
const TRIGGER_PRECEDENCE: Record<DissentTrigger, number> = {
  budget_exceeded: 0,
  high_stakes: 1,
  irreversible: 2,
  contradicts_decision: 3,
};

/** Triggers that hard-block execution and escalate to the CTO. */
const BLOCKING_TRIGGERS: Partial<Record<DissentTrigger, true>> = {
  high_stakes: true,
  irreversible: true,
  budget_exceeded: true,
};

export function evaluateDissent(opts: {
  action: string;
  stakes: "low" | "medium" | "high";
  reversible: boolean;
  contradicts_decision_tag?: string;
  budget_status?: BudgetStatus;
}): DissentEvaluation {
  const active: DissentTrigger[] = [];
  const tag = opts.contradicts_decision_tag?.trim() ?? "";

  if (opts.stakes === "high") active.push("high_stakes");
  if (opts.reversible === false) active.push("irreversible"); // rule 3: fires regardless of stakes
  if (tag.length > 0) active.push("contradicts_decision"); // rule 4: non-empty after trim
  if (opts.budget_status === "exceeded") active.push("budget_exceeded");

  if (active.length === 0) {
    return { trigger: null, severity: "none", reason: "no dissent needed", escalate_to: null };
  }

  // severity: "blocking" if ANY active trigger is blocking, else "advisory".
  const severity = active.some((t) => BLOCKING_TRIGGERS[t] === true) ? "blocking" : "advisory";
  // escalate_to: highest-priority escalation among active triggers (cto > lead).
  const escalate_to = active.some((t) => BLOCKING_TRIGGERS[t] === true) ? "cto" : "lead";

  // trigger: single most severe active trigger (precedence table above).
  const trigger = [...active].sort((a, b) => TRIGGER_PRECEDENCE[a] - TRIGGER_PRECEDENCE[b])[0]!;

  const causes: Record<DissentTrigger, string> = {
    high_stakes: `high_stakes: ${opts.action}`,
    irreversible: `irreversible: ${opts.action}`,
    contradicts_decision: `contradicts_decision: ${opts.action} (contradicts ${tag})`,
    budget_exceeded: `budget_exceeded: ${opts.action}`,
  };
  const reason = active.map((t) => causes[t]).join("; ");

  return { trigger, severity, reason, escalate_to };
}
