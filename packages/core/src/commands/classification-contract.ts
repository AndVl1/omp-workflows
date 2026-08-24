/**
 * Shared PHASE-0 classification contract for /do-work and /cto.
 *
 * Routing classification and checkpoint permission are separate control-plane
 * concerns. The legacy `autonomous` bit remains a routing/migration input and
 * its rationale is display-only. Completion intent and checkpoint policy are
 * typed fields; neither completion intent nor model routing can authorize a
 * human checkpoint.
 */

export interface ClassificationHint {
  /** Where the hint came from (e.g. "leading directive"). */
  label: string;
  /** Mechanical parser result — NOT a routing or permission decision. */
  value: boolean;
}

/** Routing fields plus explicitly separated control-plane projections. */
export const CLASSIFICATION_FIELDS = [
  "Type",
  "Complexity",
  "Confidence",
  "Autonomous (routing/migration input only)",
  "Autonomous reason (display/migration rationale only)",
  "Workflow (routing result)",
  "Completion intent (terminal outcome target)",
  "Checkpoint policy (typed permission policy)",
  "Checkpoint decision/provenance (typed authorization only)",
  "Reason",
] as const;

/** PHASE-0 block: classify routing; do not infer checkpoint consent. */
export function buildClassificationPhaseZero(hint?: ClassificationHint): string {
  const hintLines = hint
    ? [
        `- Autonomy hint (${hint.label} — MECHANICAL, NOT authoritative; routing/migration metadata only): ${hint.value ? "ON" : "OFF"}`,
      ]
    : [];
  return [
    ...hintLines,
    "### PHASE 0: INTELLIGENT CLASSIFICATION (zero step)",
    "Before any other tool call — no `read`, `glob`, `grep`, `bash`, `edit`, `write`, or `task` — understand the task semantically.",
    "Do NOT use keyword counts, task length, or language-specific keyword lists. Infer the requested outcome, primary intent, scope, constraints, risk, and the routing profile.",
    "",
    "Return this visible block before continuing:",
    "CLASSIFICATION:",
    "- Type: FEATURE | REFACTOR | OPS | BUG_FIX | SPEC | REGRESS | INVESTIGATION | REVIEW | HOTFIX | LECTURE_RESEARCH | PRODUCT_DISCOVERY",
    "- Complexity: QUICK | MEDIUM | COMPLEX | CRITICAL",
    "- Confidence: HIGH | MEDIUM | LOW",
    "- Autonomous: true | false (routing/migration input only; NEVER checkpoint permission)",
    "- Autonomous reason: one sentence — display/migration rationale only; NEVER authorization",
    "- Workflow: resolved from the routing matrix below (type + complexity + autonomous)",
    "- Completion intent: complete_outcome | handoff_only",
    "- Acceptance: dod_and_artifacts | explicit_human_acceptance",
    "- Checkpoint policy: typed required_human | autonomous_allowed policy, never inferred from this classification",
    "- Checkpoint decision: leave unresolved until a trusted typed human/policy authorization is validated",
    "- Reason: concise evidence-based routing explanation",
    "",
    "Autonomy is YOUR decision for routing only. It is a routing/migration input and does not authorize a checkpoint, waive consent,",
    "or turn completion intent, an artifact, a workflow override, or a roster choice into approval.",
    "Never copy the hint into persisted state as the decision; persist the typed routing classification separately from checkpoint permission.",
    "The typed checkpoint policy and decision provenance are authoritative; if no trusted decision",
    "exists, preserve a resumable user_checkpoint/needs_human pause. Never fabricate a human answer.",
  ].join("\n");
}

/** Workflow resolution matrix — pure routing from the model classification. */
export function buildWorkflowMatrix(): string {
  return [
    "### Workflow routing (only after PHASE 0)",
    "Resolve the profile from the routing classification (type + complexity + autonomous), not from heuristics. This field selects a workflow; it never grants checkpoint permission:",
    "| Type | QUICK | MEDIUM | COMPLEX | CRITICAL |",
    "| --- | --- | --- | --- | --- |",
    "| FEATURE | lightweight | standard | full-feature | full-feature |",
    "| REFACTOR | lightweight | standard | full-feature | full-feature |",
    "| OPS | lightweight | standard | standard | standard |",
    "| BUG_FIX | bug-fix | debug-cycle | debug-cycle | debug-cycle |",
    "| SPEC | spec-preparation | spec-preparation | spec-preparation | spec-preparation |",
    "| REGRESS | feature-regression | feature-regression | feature-regression | feature-regression |",
    "| INVESTIGATION | research | research | research | research |",
    "| LECTURE_RESEARCH | lecture-research | lecture-research | lecture-research | lecture-research |",
    "| REVIEW | review | review | review | review |",
    "| HOTFIX | emergency | emergency | emergency | emergency |",
    "| PRODUCT_DISCOVERY | product-discovery | product-discovery | product-discovery | product-discovery |",
    "",
    "> Autonomous BUG_FIX routes to debug-cycle even at QUICK complexity (autonomous=true).",
    "> SPEC, PRODUCT_DISCOVERY and REGRESS are first-class task intents and do not modify standard routing.",
    "> LECTURE_RESEARCH (one public video/playlist URL + natural-language prompt) is a DEDICATED research intent, distinct from generic",
    "> INVESTIGATION -> research: it resolves to the lecture-research profile at EVERY complexity and",
    "> autonomy, and is never routed to an implementation workflow (research-only, human approval gate). The URL is the only user content prerequisite; do not request a transcript. Acquisition is automatic through the consumer-provided `lecture_acquire` tool; provider setup is an installation concern and core does not fetch URLs.",
    "> PRODUCT_DISCOVERY is ALWAYS human-approved: autonomous=true fails closed at the classification gate.",
    "> Its product_approval checkpoint requires one trusted typed human decision: proceed | needs_more_validation | defer | reject.",
    "> The P5 gate re-derives expected routing from persisted classification.autonomous during migration only.",
    "> Never re-derive permission from task text, markers, completion intent, or legacy prose.",
  ].join("\n");
}
