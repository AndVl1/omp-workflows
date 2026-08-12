/**
 * DEMOTED keyword classifier — no longer an authority.
 *
 * The model-first contract (RC2+): the main LLM classifies
 * `type`/`complexity`/`confidence`/`autonomous` together at PHASE-0 from the
 * COMPLETE task semantics in any language. `keywordClassify` is a bounded
 * keyword heuristic kept ONLY for legacy engine callers that run `run()`
 * without a model classification; it cannot decide autonomy (the return
 * type has no `autonomous` field) and it is never consulted on the
 * model-first command path (`run()` refuses to fill a partial model
 * classification from keywords).
 */

import type { Complexity, Confidence, TaskType } from "./types.js";

/**
 * Keyword-only guess: type/complexity/confidence. Deliberately carries NO
 * `autonomous` — a keyword scanner must never decide the autonomy flag.
 */
export interface KeywordGuess {
  type: TaskType;
  complexity: Complexity;
  confidence: Confidence;
}

const TYPE_KEYWORDS: Record<TaskType, string[]> = {
  FEATURE: ["add", "implement", "create", "build", "new", "introduce", "feature"],
  BUG_FIX: ["fix", "broken", "error", "doesn't work", "bug", "failing"],
  SPEC: ["spec", "specification", "requirements", "implementation-ready", "implementation ready"],
  REGRESS: ["regression", "regress", "replay", "test matrix"],
  INVESTIGATION: ["why", "investigate", "understand", "find out", "research", "explore"],
  REVIEW: ["review", "check", "audit", "feedback", "audit"],
  HOTFIX: ["urgent", "production", "critical", "asap", "hotfix", "incident"],
  REFACTOR: ["refactor", "clean up", "improve", "optimize", "rewrite"],
  OPS: ["build", "deploy", "test", "docker", "k8s", "ci", "pipeline", "infra"],
};

const COMPLEXITY_HINTS: Record<Complexity, string[]> = {
  QUICK: ["one", "single", "tiny", "small", "1-2 files"],
  MEDIUM: ["few", "small set", "2-5 files"],
  COMPLEX: ["many", "multiple modules", "5+ files", "architecture"],
  CRITICAL: ["prod", "production", "outage", "incident", "critical"],
};

export function keywordClassify(task: string): KeywordGuess {
  const lower = task.toLowerCase();
  const type = pickType(lower);
  const complexity = pickComplexity(lower, type);
  const confidence = pickConfidence(lower, type);
  return { type, complexity, confidence };
}

function pickType(lower: string): TaskType {
  // HOTFIX wins first; urgency beats everything else.
  if (TYPE_KEYWORDS.HOTFIX.some((k) => lower.includes(k))) return "HOTFIX";
  if (TYPE_KEYWORDS.SPEC.some((k) => lower.includes(k))) return "SPEC";
  if (TYPE_KEYWORDS.REGRESS.some((k) => lower.includes(k))) return "REGRESS";
  const scored: Record<TaskType, number> = {
    FEATURE: 0,
    BUG_FIX: 0,
    SPEC: 0,
    REGRESS: 0,
    INVESTIGATION: 0,
    REVIEW: 0,
    HOTFIX: 0,
    REFACTOR: 0,
    OPS: 0,
  };
  for (const t of Object.keys(TYPE_KEYWORDS) as TaskType[]) {
    for (const k of TYPE_KEYWORDS[t]) {
      if (lower.includes(k)) scored[t] += 1;
    }
  }
  const sorted = (Object.entries(scored) as Array<[TaskType, number]>)
    .filter(([t]) => t !== "HOTFIX")
    .sort((a, b) => b[1] - a[1]);
  return (sorted[0]?.[0] ?? "FEATURE") as TaskType;
}

function pickComplexity(lower: string, _type: TaskType): Complexity {
  for (const [level, hints] of Object.entries(COMPLEXITY_HINTS) as Array<[Complexity, string[]]>) {
    if (hints.some((h) => lower.includes(h))) return level;
  }
  return "MEDIUM";
}

function pickConfidence(_lower: string, _type: TaskType): Confidence {
  // The original `/team` semantics — LOW is only after a clarification loop.
  // For a fresh request, default to HIGH.
  return "HIGH";
}
