/**
 * CTO gates: per-team DoD, integration DoD, backstop.
 *
 * DoD aggregation (R11): each team writes its own dod.json; the integration
 * phase requires every team done AND its DoD complete. The backstop mirrors
 * gates/dod-backstop.ts semantics for CtoState — it only blocks at a
 * done-claim, never during background_wait / needs_human / failed pauses.
 */

import { join } from "node:path";
import { isDoDComplete, readDoD } from "../engine/dod.js";
import { checkBudget } from "./budget.js";
import type { CtoState } from "./types.js";

export type GateResult = { ok: true } | { ok: false; reason: string };

/** A single team's DoD (its dod.json under the team's artifact dir). */
export function teamDoDComplete(state: CtoState, teamId: string, root: string): GateResult {
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) return { ok: false, reason: `unknown team: ${teamId}` };
  if (!team.dod_path) return { ok: false, reason: `team ${teamId} has no dod_path — DoD not claimed` };
  const dod = readDoD(join(root, team.dod_path));
  const check = isDoDComplete(dod);
  return check.ok ? { ok: true } : { ok: false, reason: `team ${teamId} DoD: ${check.pending.map((p) => p.id).join(", ")}` };
}

/** Integration gate: every team done + every team DoD complete. */
export function integrationDoD(state: CtoState, root: string): GateResult {
  if (state.integration.status === "failed") {
    return { ok: false, reason: `integration failed: ${state.integration.note ?? "no note"}` };
  }
  const notDone = state.teams.filter((t) => t.status !== "done");
  if (notDone.length > 0) {
    return { ok: false, reason: `teams not done: ${notDone.map((t) => t.id).join(", ")}` };
  }
  for (const team of state.teams) {
    const check = teamDoDComplete(state, team.id, root);
    if (!check.ok) return check;
  }
  return { ok: true };
}

/**
 * Backstop gate (R11): block ONLY at a done-claim. Allow stopping during
 * background_wait (parked team), needs_human (blocker), failed — mirroring
 * gates/dod-backstop.ts.
 */
export function ctoBackstop(state: CtoState, root: string): { continue: true } | { decision: "block"; reason: string } {
  const kind = state.pause.kind;
  if (kind === "background_wait" || kind === "needs_human" || kind === "failed") return { continue: true };

  const claimingDone = kind === "done" || state.integration.status === "done";
  if (!claimingDone) return { continue: true };

  const check = integrationDoD(state, root);
  if (!check.ok) {
    return {
      decision: "block",
      reason: `CTO DoD: ${check.reason}. To pause instead, set pause.kind to background_wait | needs_human | failed.`,
    };
  }
  return { continue: true };
}

/**
 * Conditional dissent gate (architecture §4.11 — br-zps.10, cto-quality).
 * Dissent triggers ONLY on high-stakes, irreversible, or budget-exceeding
 * actions — low-stakes reversible work passes with NO dissent check (no gate
 * tax). Semantics, highest precedence first:
 *
 *   1. budget status "exceeded" → block; <teamId> must escalate to cto.
 *   2. stakes === "high" or reversible === false → block; <teamId> must
 *      escalate to cto (trigger names included in the reason).
 *   3. else → { ok: true }.
 *
 * Contradiction checks are NOT performed here: this gate has no
 * contradicts_decision_tag in its signature, so it does not read decision
 * memory. Tag-aware contradiction dissent happens via evaluateDissent()
 * (dissent.ts) where the calling layer can supply a tag.
 *
 * `checkBudget` tolerates a state without the optional schema-2 `budget`
 * field (D3: all limits null → "unlimited"), so no guard is needed here.
 */
export function dissentGate(
  state: CtoState,
  teamId: string,
  action: { stakes: "low" | "medium" | "high"; reversible: boolean },
): GateResult {
  if (checkBudget(state).status === "exceeded") {
    return {
      ok: false,
      reason: `dissent: budget exceeded — ${teamId} must escalate to cto (stakes: ${action.stakes}, reversible: ${action.reversible})`,
    };
  }
  const triggers: string[] = [];
  if (action.stakes === "high") triggers.push("high_stakes");
  if (action.reversible === false) triggers.push("irreversible");
  if (triggers.length > 0) {
    return {
      ok: false,
      reason: `dissent: ${triggers.join(", ")} — ${teamId} must escalate to cto (stakes: ${action.stakes}, reversible: ${action.reversible})`,
    };
  }
  return { ok: true };
}
