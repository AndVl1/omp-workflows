/**
 * Task type classifier. Lightweight keyword-based heuristic — the original
 * claude-plugin's `/team` command does the same in prose. Returns a
 * `Classification` for `resolveWorkflow()` to map to a profile.
 *
 * This is the FIRST STEP the engine runs, before any state is written, so
 * the model should classify via this helper for consistency.
 *
 * Autonomy contract (RC2): `classify` never derives the autonomous flag
 * from task text — the flag comes exclusively from the shared envelope
 * parser (`parseAutonomousDirective`) and is consumed by the workflow
 * driver (`resolveWorkflow(type, complexity, autonomous)`), which is what
 * the P5 gate recomputes from the persisted state. The `workflow` field
 * returned here is a placeholder resolved by the driver with that flag.
 */

import type { Classification, Complexity, Confidence, TaskType } from "./types.js";

const TYPE_KEYWORDS: Record<TaskType, string[]> = {
  FEATURE: ["add", "implement", "create", "build", "new", "introduce", "feature"],
  BUG_FIX: ["fix", "broken", "error", "doesn't work", "bug", "failing", "regression"],
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

export function classify(
  task: string,
  opts: { autonomous?: boolean } = {},
): Classification {
  const lower = task.toLowerCase();
  const type = pickType(lower);
  const complexity = pickComplexity(lower, type);
  const confidence = pickConfidence(lower, type);
  return { type, complexity, confidence, workflow: "standard" }; // workflow resolved by classifier driver
}

function pickType(lower: string): TaskType {
  // HOTFIX wins first; urgency beats everything else.
  if (TYPE_KEYWORDS.HOTFIX.some((k) => lower.includes(k))) return "HOTFIX";
  const scored: Record<TaskType, number> = {
    FEATURE: 0,
    BUG_FIX: 0,
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
