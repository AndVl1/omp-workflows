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
