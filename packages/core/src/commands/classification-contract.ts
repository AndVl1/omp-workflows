/**
 * Shared PHASE-0 classification contract for /do-work and /cto.
 *
 * Both command surfaces MUST request the same four-field model
 * classification (type, complexity, confidence, autonomous) so the main LLM
 * decides autonomy from the COMPLETE task semantics in any language. The
 * mechanical parser hint (`autonomyHint`) is rendered as non-authoritative
 * metadata: it never decides and is never copied into persisted state as
 * the decision. Missing/non-boolean model output fails closed at the P5
 * gate (gates/classification.ts) — no silent true/false default.
 */

export interface ClassificationHint {
  /** Where the hint came from (e.g. "leading directive"). */
  label: string;
  /** Mechanical parser result — NOT the model decision. */
  value: boolean;
}

/** The four model-classified fields, requested verbatim by both commands. */
export const CLASSIFICATION_FIELDS = [
  "Type",
  "Complexity",
  "Confidence",
  "Autonomous",
  "Autonomous reason",
  "Workflow",
  "Reason",
] as const;

/** PHASE-0 block: the model classifies type/complexity/confidence/autonomous together. */
export function buildClassificationPhaseZero(hint?: ClassificationHint): string {
  const hintLines = hint
    ? [
        `- Autonomy hint (${hint.label} — MECHANICAL, NOT authoritative): ${hint.value ? "ON" : "OFF"}`,
      ]
    : [];
  return [
    "### PHASE 0: INTELLIGENT CLASSIFICATION (zero step)",
    "Before any other tool call — no `read`, `glob`, `grep`, `bash`, `edit`, `write`, or `task` — understand the task semantically.",
    "Do NOT use keyword counts, task length, or language-specific keyword lists. Infer the requested outcome, primary intent, scope, constraints, risk, and whether code changes are actually requested.",
    "",
    "Return this visible block before continuing:",
    "CLASSIFICATION:",
    "- Type: FEATURE | REFACTOR | OPS | BUG_FIX | SPEC | REGRESS | INVESTIGATION | REVIEW | HOTFIX",
    "- Complexity: QUICK | MEDIUM | COMPLEX | CRITICAL",
    "- Confidence: HIGH | MEDIUM | LOW",
    "- Autonomous: true | false",
    "- Autonomous reason: one sentence — may this task proceed without user checkpoints, and why",
    "- Workflow: resolved from the matrix below (type + complexity + autonomous)",
    "- Reason: concise evidence-based explanation",
    "",
    "Autonomy is YOUR decision, made from the COMPLETE task semantics in ANY language: urgency,",
    "phrasing, implied permission, risk, and explicit directives together. The autonomy hint below",
    "is a mechanical leading-directive marker, NOT the decision — a task without any marker can be",
    "autonomous, and a marked task can still be interactive. Never copy the hint into persisted",
    "state as the decision; persist your own `autonomous` classification.",
    ...hintLines,
  ].join("\n");
}

/** Workflow resolution matrix — the pure mapping from the model classification. */
export function buildWorkflowMatrix(): string {
  return [
    "### Workflow resolution (only after PHASE 0)",
    "Resolve the profile from your semantic classification (type + complexity + autonomous), not from heuristics:",
    "| Type | QUICK | MEDIUM | COMPLEX | CRITICAL |",
    "| --- | --- | --- | --- | --- |",
    "| FEATURE | lightweight | standard | full-feature | full-feature |",
    "| REFACTOR | lightweight | standard | full-feature | full-feature |",
    "| OPS | lightweight | standard | standard | standard |",
    "| BUG_FIX | bug-fix | debug-cycle | debug-cycle | debug-cycle |",
    "| SPEC | spec-preparation | spec-preparation | spec-preparation | spec-preparation |",
    "| REGRESS | feature-regression | feature-regression | feature-regression | feature-regression |",
    "| INVESTIGATION | research | research | research | research |",
    "| REVIEW | review | review | review | review |",
    "| HOTFIX | emergency | emergency | emergency | emergency |",
    "",
    "> Autonomous BUG_FIX resolves to debug-cycle even at QUICK complexity (autonomous=true).",
    "> SPEC and REGRESS are first-class task intents and do not modify the standard FEATURE/BUG_FIX routing.",
    "> The P5 gate re-derives the expected workflow from the persisted classification",
    "(`classification.autonomous`), so the workflow row must match this matrix. Never re-derive",
    "autonomy from task text or markers — the model `autonomous` field is the only authority."
  ].join("\n");
}
