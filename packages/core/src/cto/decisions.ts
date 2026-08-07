/**
 * Project decision memory (architecture §4.3, br-zps.11).
 *
 * Tag-based recall only (D6): exact-match on `tags`/`by`, project-scoped —
 * every entry lives in one run's `CtoState`, never shared across instances,
 * no semantic search. `state.json` stays canonical; `decisionsToMarkdown`
 * is a deterministic projection for the human-readable `decisions.md`.
 */

import { randomUUID } from "node:crypto";
import type { CtoState, DecisionMemoryEntry } from "./types.js";
import { writeCtoState } from "./state.js";

/**
 * Append a decision to the run's memory. `why` is MANDATORY and non-empty
 * (architecture §4.3) — empty/whitespace rationale throws a descriptive
 * Error and leaves `state` untouched. When `root` is provided, the mutated
 * state is persisted via `writeCtoState` (runId derived from `state.id`,
 * same as `leases.ts`) and the persisted state is returned; when `root` is
 * null the mutation is purely in-memory.
 */
export function recordDecision(
  state: CtoState,
  entry: Omit<DecisionMemoryEntry, "id" | "at">,
  root: string | null = null,
): CtoState {
  if (typeof entry.why !== "string" || entry.why.trim().length === 0) {
    throw new Error(
      `recordDecision: "why" is mandatory and must be non-empty (got ${JSON.stringify(entry.why)}) — refusing to record a decision without a rationale`,
    );
  }
  if (!state.decisions) state.decisions = [];
  state.decisions.push({
    ...entry,
    id: randomUUID(),
    at: new Date().toISOString(),
  });
  if (root) writeCtoState(state, root);
  return state;
}

/**
 * Tag-based recall (D6). Every requested `tags` entry must be present in an
 * entry's tags (AND semantics); `by` is an exact match. No tags and no `by`
 * → all entries. Results are newest-first (sorted by `at` desc, id as a
 * stable tie-break); `limit` caps the result length. Entries are returned
 * as shallow copies so callers cannot mutate the canonical state by
 * accident.
 */
export function recallDecisions(
  state: CtoState,
  opts: { tags?: string[]; by?: string; limit?: number } = {},
): DecisionMemoryEntry[] {
  const tags = opts.tags?.length ? opts.tags : undefined;
  const by = opts.by;
  const matched = (state.decisions ?? []).filter((entry) => {
    if (tags) {
      for (const tag of tags) {
        if (!entry.tags.includes(tag)) return false;
      }
    }
    if (by !== undefined && entry.by !== by) return false;
    return true;
  });
  matched.sort((a, b) => {
    const diff = Date.parse(b.at) - Date.parse(a.at);
    if (diff !== 0 || Number.isNaN(diff)) {
      if (!Number.isNaN(diff)) return diff;
      // non-ISO fallback: plain string comparison, still newest-first intent
      return b.at < a.at ? -1 : b.at > a.at ? 1 : 0;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const slice = limit === undefined ? matched : matched.slice(0, limit);
  return slice.map((entry) => ({ ...entry }));
}

/**
 * Deterministic, human-readable projection for `decisions.md` (audit
 * surface only — `state.json` remains canonical). Entries are listed
 * newest-first, matching `recallDecisions` ordering.
 */
export function decisionsToMarkdown(state: CtoState): string {
  const entries = recallDecisions(state);
  const lines = ["## Decisions"];
  if (entries.length === 0) {
    lines.push("", "_No decisions recorded._");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push("", `### ${entry.id}`, `- at: ${entry.at}`, `- by: ${entry.by}`);
    lines.push(`- tags: ${entry.tags.join(", ") || "(none)"}`);
    if (entry.refs && entry.refs.length > 0) lines.push(`- refs: ${entry.refs.join(", ")}`);
    lines.push(`- decision: ${entry.decision}`, `- why: ${entry.why}`);
  }
  return lines.join("\n");
}
