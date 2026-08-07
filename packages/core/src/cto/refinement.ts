/**
 * CTO task refinement — five-whys validation/structuring (br-zps.9).
 *
 * Five-whys reasoning is LLM work driven by the agent prompt. This module is
 * PURE TS: deterministic validation and structuring of the refinement artifact
 * the agent writes to `.work-state/cto/<id>/refinement.json`. No IO, no
 * randomness, no LLM calls.
 */

import type { RefinementResult } from "./types.js";

/** Trim and collapse internal whitespace runs to single spaces. */
function normalizeTask(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Deterministic seed refinement for a raw task string.
 *
 * The AGENT drives the actual five-whys interactively (prompt); this function
 * returns the seed chain of length 1 — the problem statement is why #1 —
 * which the agent extends/completes in `.work-state/cto/<id>/refinement.json`.
 *
 * `context` is informational (agent-facing): it does NOT change the
 * deterministic result. The agent uses it to reason about the whys.
 */
export function refineTask(rawTask: string, context?: string): RefinementResult {
  if (typeof rawTask !== "string") {
    throw new TypeError(`refineTask: rawTask must be a string, got ${typeof rawTask}`);
  }
  if (context !== undefined && typeof context !== "string") {
    throw new TypeError(`refineTask: context must be a string when provided, got ${typeof context}`);
  }
  const task = normalizeTask(rawTask);
  if (task.length === 0) {
    throw new TypeError("refineTask: rawTask must not be empty after normalization");
  }
  return {
    original_task: task,
    whys: [task],
    root_cause: task,
    refined_task: task,
    converged: false,
  };
}

/**
 * Validate a refinement artifact (`unknown` → `RefinementResult` or `null`).
 *
 * Returns the validated data typed as `RefinementResult` (input is NOT
 * mutated) or `null` when ANY rule fails:
 * - data is a non-null object
 * - `original_task` / `root_cause` / `refined_task` are non-empty strings
 * - `whys` is an array of 1..5 non-empty strings
 * - `converged` is a boolean
 * - `converged === true` requires `whys.length < 5` (a 5-length chain is
 *   never converged-early — convergence means root cause reached BEFORE five)
 */
export function validateRefinement(data: unknown): RefinementResult | null {
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Record<string, unknown>;

  const { original_task, root_cause, refined_task, whys, converged } = candidate;

  if (typeof original_task !== "string" || original_task.trim().length === 0) return null;
  if (typeof root_cause !== "string" || root_cause.trim().length === 0) return null;
  if (typeof refined_task !== "string" || refined_task.trim().length === 0) return null;

  if (!Array.isArray(whys) || whys.length < 1 || whys.length > 5) return null;
  for (const why of whys) {
    if (typeof why !== "string" || why.trim().length === 0) return null;
  }

  if (typeof converged !== "boolean") return null;
  if (converged && whys.length >= 5) return null;

  // Same object reference as the input — validation never mutates.
  return data as RefinementResult;
}
