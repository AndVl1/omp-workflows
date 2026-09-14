/**
 * CTO budget slice (architecture §4.2, §8 — br-zps.2, team cto-operations).
 *
 * Budget is a DECLARED policy, never enforcement (D3): `checkBudget` reports
 * a status and a human-readable detail; nothing here hard-stops a run — the
 * caller (engine / team lead) decides how to react. All limits are `null` by
 * default (unlimited), and spend accounting uses the chars/4 heuristic (C1)
 * until a real token-meter `BudgetRecorder` is wired in; dollars stay 0.
 *
 * Mutations operate on the passed in-memory `CtoState`; persistence belongs to
 * the caller's trusted runtime transaction.
 */

import type { BudgetState, BudgetStatus, CtoState } from "./types.js";
import { isSafeCtoRunId, isSafeBudgetDollar, isSafeBudgetInteger, persistedBudgetValid } from "./state.js";
import type { ObservabilityEvent } from "../observability/events.js";

/**
 * Default schema-2 budget shape (D3): all limits null (unlimited), all
 * accounting zero, no per-team spend. Identical to `state.ts`'s internal
 * `defaultBudgetShape()` — the exported copy so consumers can construct or
 * reset budget state without reaching into cto-core internals.
 */
export function defaultBudgetState(): BudgetState {
  return {
    policy: { token_limit: null, dollar_limit: null, time_limit_ms: null },
    accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
  };
}

/**
 * Elapsed time for the run, ms. `CtoState` carries no explicit run-start
 * timestamp; the earliest available approximation is `updated_at` (stamped
 * by `newCtoState` and every `writeCtoState`). Documented approximation:
 * run start ≈ latest persisted state write. Unparseable timestamps disable
 * the time metric (returns 0, so time never trips a limit).
 */
function elapsedMs(state: CtoState, now: number): number {
  const start = Date.parse(state.updated_at);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, now - start);
}

/**
 * Status precedence (lead decision, architecture §4.2): all limits null →
 * "unlimited"; any metric >= its limit → "exceeded"; any metric >= 80% of
 * its limit → "approaching"; else "ok". `detail` names the first metric/limit
 * that tripped, in tokens → dollars → elapsed order. An absent `state.budget`
 * is treated as the default (unlimited) shape.
 */
export function checkBudget(state: CtoState, now: number = Date.now()): { status: BudgetStatus; detail?: string } {
  const budget = state.budget ?? defaultBudgetState();
  const { policy, accounting } = budget;
  const metrics = [
    { name: "tokens", metric: accounting.tokens_estimated, limit: policy.token_limit },
    { name: "dollars", metric: accounting.dollars_estimated, limit: policy.dollar_limit },
    { name: "elapsed", metric: elapsedMs(state, now), limit: policy.time_limit_ms },
  ];
  const configured = metrics.filter((m) => m.limit !== null);
  if (configured.length === 0) return { status: "unlimited" };

  const exceeded = configured.find((m) => m.metric >= (m.limit as number));
  if (exceeded) {
    return { status: "exceeded", detail: `${exceeded.name} ${exceeded.metric} >= limit ${exceeded.limit}` };
  }
  const approaching = configured.find((m) => m.metric >= (m.limit as number) * 0.8);
  if (approaching) {
    return { status: "approaching", detail: `${approaching.name} ${approaching.metric} >= 80% of limit ${approaching.limit}` };
  }
  return { status: "ok" };
}

/**
 * Add spend to the run's accounting: totals (`tokens_estimated`,
 * `dollars_estimated`) and the `per_team[teamId]` entry (created on first
 * spend for the team, `ms` untouched — elapsed is tracked by the health
 * slice, br-zps.7). The transition performs no persistence.
 */
export function recordSpend(state: CtoState, teamId: string, tokens: number, dollars: number): CtoState {
  if (!isSafeCtoRunId(teamId)) throw new Error("recordSpend: invalid team id");
  if (!isSafeBudgetInteger(tokens) || !isSafeBudgetDollar(dollars)) throw new Error("recordSpend: spend values are invalid");
  const apply = (current: CtoState): void => {
    const budget = current.budget ?? defaultBudgetState();
    if (!persistedBudgetValid(budget)) throw new Error("recordSpend: current budget is invalid");
    const existing = budget.accounting.per_team[teamId] ?? { tokens: 0, dollars: 0, ms: 0 };
    const nextBudget: BudgetState = {
      ...budget,
      accounting: {
        ...budget.accounting,
        tokens_estimated: budget.accounting.tokens_estimated + tokens,
        dollars_estimated: budget.accounting.dollars_estimated + dollars,
        per_team: {
          ...budget.accounting.per_team,
          [teamId]: {
            tokens: existing.tokens + tokens,
            dollars: existing.dollars + dollars,
            ms: existing.ms,
          },
        },
      },
    };
    if (!persistedBudgetValid(nextBudget)) throw new Error("recordSpend: spend exceeds persisted budget bounds");
    current.budget = nextBudget;
  };
  apply(state);
  return state;
}

/**
 * Consumer-implemented spend recorder. The engine/team lead feeds observed
 * observability events through a recorder; `record` returns the spend to
 * attribute (tokens/dollars), which callers pass to `recordSpend`.
 */
export interface BudgetRecorder {
  record(event: ObservabilityEvent): { tokens?: number; dollars?: number };
}

/**
 * Declared chars/4 approximation (C1): tokens = floor(chars / 4), dollars 0.
 * The natural char source is `subagentTaskChars` — the size (chars) of a
 * `task` tool-call prompt, already captured by the observability recorder
 * for exactly this purpose. Events without it (no subagent task) record 0.
 * Deterministic; replaced once a real token-meter recorder is wired in.
 */
export const CHAR_HEURISTIC_RECORDER: BudgetRecorder = {
  record(event: ObservabilityEvent): { tokens?: number; dollars?: number } {
    const chars = typeof event.subagentTaskChars === "number" && event.subagentTaskChars > 0 ? event.subagentTaskChars : 0;
    return { tokens: Math.floor(chars / 4), dollars: 0 };
  },
};
