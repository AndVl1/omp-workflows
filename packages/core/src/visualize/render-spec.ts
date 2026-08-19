/**
 * Visualize OPT-A — structured renderers: spec-family + 22 typed schema
 * (architecture-4).
 *
 * `renderSpecArtifact` serves the 7 known spec-preparation ids
 * (spec_intake_repo_map, spec_requirements_edge_cases, spec_options_decisions,
 * spec_architecture_tasks, spec_completeness, spec-preparation, spec_handoff)
 * with per-id presentation plans so the payload reads as useful
 * headings/lists/tables — requirements, edge cases, options/decisions,
 * architecture/task slices, completeness, handoff — rather than a bare
 * key-value tree. Unknown `spec_*` ids are absent from the registry table
 * and fall through to the bounded generic fallback.
 *
 * `renderTypedArtifact` serves the 22 typed schema ids (the frozen
 * TYPED_ARTIFACT_IDS) with per-type plans derived from artifacts-schema.json.
 *
 * Both are pure: no fs, no network, no mutation; they consume only the
 * immutable normalized artifact (its redacted, capped body) plus the frozen
 * render options/bounds. When the redacted body no longer parses as JSON
 * (redaction drops whole secret lines by design) they degrade to the bounded
 * raw-text view — never to an exception. Section order is deterministic:
 * plan order first, then remaining top-level fields in JSON parse order —
 * nothing is dropped.
 */

import {
  ARTIFACT_HEADING_LEVEL,
  boundedText,
  boundsMarkerOf,
  bodyPreviewMarker,
  artifactHeading,
  artifactMetaNodes,
  clampLevel,
  code,
  h,
  kv,
  list,
  p,
  parseBoundedJson,
  table,
  type ArtifactRenderer,
  type RenderNode,
} from "./renderer-registry.js";
import { compactValue, objectTable, renderJsonValue } from "./render-json.js";
import { EMPTY_BODY_MARKER, REDACTED_MARKER, type RenderOptions, type VisualizationArtifact } from "./types.js";

// ── Section presentation vocabulary ──────────────────────────────────────────

type SectionHint = "auto" | "list" | "table" | "kv" | "nested";

interface SectionPlan {
  /** Payload field(s) rendered by this section — the first present one wins. */
  fields: readonly string[];
  title: string;
  hint: SectionHint;
}

interface ArtifactPresentation {
  /** Reader-visible subtitle under the artifact heading. */
  title: string;
  sections: SectionPlan[];
}

function section(fields: readonly string[], title: string, hint: SectionHint = "auto"): SectionPlan {
  return { fields, title, hint };
}

/** "task_slices" → "Task slices" (auto titles for unplanned fields). */
export function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// ── Spec-family presentations (7 known ids) ─────────────────────────────────

const SPEC_PRESENTATIONS: Readonly<Record<string, ArtifactPresentation>> = {
  spec_intake_repo_map: {
    title: "Repository intake map",
    sections: [
      section(["summary"], "Summary"),
      section(["verified_facts"], "Verified facts", "table"),
      section(["affected_paths"], "Affected paths", "list"),
      section(["conventions"], "Conventions", "list"),
      section(["assumptions"], "Assumptions", "list"),
      section(["open_questions"], "Open questions", "list"),
      section(["constraints"], "Constraints", "list"),
      section(["evidence"], "Evidence", "list"),
      section(["options_evidence"], "Options evidence", "nested"),
    ],
  },
  spec_requirements_edge_cases: {
    title: "Requirements and edge cases",
    sections: [
      section(["purpose"], "Purpose"),
      section(["user_request_verbatim"], "User request (verbatim)"),
      section(["fact_corrections"], "Fact corrections", "list"),
      section(["requirements"], "Requirements", "table"),
      section(["non_goals"], "Non-goals", "list"),
      section(["acceptance_criteria"], "Acceptance criteria", "list"),
      section(["invariants"], "Invariants", "list"),
      section(["error_behavior"], "Error behavior", "list"),
      section(["lifecycle"], "Lifecycle", "list"),
      section(["security_privacy"], "Security and privacy", "list"),
      section(["compatibility"], "Compatibility", "list"),
      section(["edge_cases"], "Edge cases", "list"),
      section(["decisions_needed"], "Decisions needed", "list"),
      section(["traceability"], "Traceability", "nested"),
    ],
  },
  spec_options_decisions: {
    title: "Options and decision log",
    sections: [
      section(["outcome_contract"], "Outcome contract", "nested"),
      section(["acceptance_contract"], "Acceptance contract", "nested"),
      section(["implementation_options"], "Implementation options", "table"),
      section(["options"], "Options", "table"),
      section(["recommendation"], "Recommendation"),
      section(["non_binding_choices"], "Non-binding choices", "list"),
      section(["material_decisions"], "Material decisions", "table"),
      section(["rejected_alternatives"], "Rejected alternatives", "table"),
      section(["assumptions"], "Assumptions", "list"),
      section(["decision_gates"], "Decision gates", "table"),
      section(["traceability"], "Traceability", "nested"),
    ],
  },
  spec_architecture_tasks: {
    title: "Architecture and task slices",
    sections: [
      section(["architecture"], "Architecture", "nested"),
      section(["data_flow"], "Data flow"),
      section(["contracts"], "Contracts"),
      section(["output_layout"], "Output layout"),
      section(["migration_order"], "Migration order", "list"),
      section(["task_slices"], "Task slices", "table"),
      section(["authoritative_task_slices"], "Authoritative task slices", "table"),
      section(["observability"], "Observability"),
      section(["test_strategy"], "Test strategy"),
      section(["risks"], "Risks", "list"),
      section(["verdict"], "Verdict"),
      section(["challenge_summary"], "Challenge summary"),
      section(["validated_assumptions"], "Validated assumptions", "list"),
      section(["failure_modes"], "Failure modes", "list"),
      section(["security_review"], "Security review"),
      section(["compatibility_review"], "Compatibility review"),
      section(["test_gaps"], "Test gaps", "list"),
      section(["recommended_corrections"], "Recommended corrections", "list"),
      section(["risk_classification"], "Risk classification"),
      section(["traceability"], "Traceability", "nested"),
    ],
  },
  spec_completeness: {
    title: "Completeness gate",
    sections: [
      section(["verdict"], "Verdict"),
      section(["verdict_reason"], "Verdict reason"),
      section(["audit_summary"], "Audit summary"),
      section(["audit_scope"], "Audit scope"),
      section(["traceability"], "Traceability", "nested"),
      section(["blocking_gaps"], "Blocking gaps", "list"),
      section(["warnings"], "Warnings", "list"),
      section(["decision_gates"], "Decision gates", "table"),
      section(["recommendation"], "Recommendation"),
      section(["verification"], "Verification", "nested"),
    ],
  },
  "spec-preparation": {
    title: "Specification",
    sections: [
      section(["summary"], "Summary"),
      section(["classification"], "Classification", "kv"),
      section(["verified_facts"], "Verified facts", "table"),
      section(["requirements_traceability"], "Requirements traceability", "table"),
      section(["alternative_options"], "Alternative options", "table"),
      section(["proposed_baseline"], "Proposed baseline", "nested"),
      section(["decision_log"], "Decision log", "table"),
      section(["material_decisions"], "Material decisions", "table"),
      section(["decision_gates"], "Decision gates", "table"),
      section(["open_decisions_with_defaults"], "Open decisions", "table"),
      section(["non_binding_choices"], "Non-binding choices", "list"),
      section(["warnings_and_required_pins"], "Warnings and required pins", "list"),
      section(["assumptions"], "Assumptions", "list"),
      section(["architecture"], "Architecture", "nested"),
      section(["authoritative_task_slices"], "Task slices", "table"),
      section(["verification_plan"], "Verification plan", "nested"),
      section(["outcome_contract"], "Outcome contract", "nested"),
      section(["acceptance_contract"], "Acceptance contract", "nested"),
      section(["contract_freeze_pins"], "Contract freeze pins", "list"),
      section(["change_scope"], "Change scope", "nested"),
      section(["provenance"], "Provenance", "nested"),
    ],
  },
  spec_handoff: {
    title: "Handoff",
    sections: [
      section(["headline"], "Headline"),
      section(["outcome_contract"], "Outcome contract", "nested"),
      section(["recommended_default"], "Recommended default", "nested"),
      section(["options"], "Options", "table"),
      section(["material_decisions"], "Material decisions", "table"),
      section(["decision_gates"], "Decision gates", "table"),
      section(["implementation_contract"], "Implementation contract", "kv"),
      section(["implementation_order"], "Implementation order", "table"),
      section(["acceptance_contract"], "Acceptance contract", "nested"),
      section(["verification"], "Verification", "nested"),
      section(["open_decisions_with_defaults"], "Open decisions", "table"),
      section(["change_scope"], "Change scope", "nested"),
      section(["next_step"], "Next step"),
      section(["provenance"], "Provenance", "nested"),
    ],
  },
};

// ── Typed schema presentations (22 ids) ──────────────────────────────────────

const TYPED_PRESENTATIONS: Readonly<Record<string, ArtifactPresentation>> = {
  discovery: { title: "Discovery", sections: [section(["task"], "Task"), section(["branch"], "Branch"), section(["constraints"], "Constraints", "list")] },
  exploration: {
    title: "Exploration",
    sections: [
      section(["files_to_read"], "Files to read", "table"),
      section(["patterns"], "Patterns", "list"),
      section(["similar_features"], "Similar features", "list"),
      section(["integration_points"], "Integration points", "list"),
      section(["summary"], "Summary"),
    ],
  },
  clarifications: { title: "Clarifications", sections: [section(["questions"], "Questions", "list"), section(["answers"], "Answers", "list")] },
  architecture: {
    title: "Architecture",
    sections: [
      section(["options"], "Options", "table"),
      section(["chosen"], "Chosen option"),
      section(["rationale"], "Rationale"),
      section(["files_to_modify"], "Files to modify", "list"),
      section(["api_contract"], "API contract", "nested"),
    ],
  },
  diagnosis: {
    title: "Diagnosis",
    sections: [
      section(["root_cause"], "Root cause"),
      section(["evidence"], "Evidence", "list"),
      section(["proposed_fix"], "Proposed fix"),
      section(["verification_checklist"], "Verification checklist", "list"),
    ],
  },
  implementation: {
    title: "Implementation",
    sections: [
      section(["files_touched"], "Files touched", "list"),
      section(["commits"], "Commits", "list"),
      section(["build_status"], "Build status"),
      section(["scope"], "Scope", "list"),
    ],
  },
  debug: { title: "Debug", sections: [section(["verdict"], "Verdict"), section(["iterations"], "Iterations"), section(["manual_qa_log"], "Manual QA log"), section(["screenshots"], "Screenshots", "list")] },
  review: { title: "Review", sections: [section(["verdict"], "Verdict"), section(["findings"], "Findings", "table"), section(["tests"], "Tests", "kv")] },
  summary: { title: "Summary", sections: [section(["built"], "Built", "list"), section(["decisions"], "Decisions", "list"), section(["files_modified"], "Files modified", "list"), section(["pr_url"], "PR URL")] },
  manual_qa: {
    title: "Manual QA",
    sections: [
      section(["verdict"], "Verdict"),
      section(["mode"], "Mode"),
      section(["evidence"], "Evidence", "list"),
      section(["dod_additions"], "DoD additions", "table"),
      section(["regressions"], "Regressions", "list"),
    ],
  },
  qa_tests: {
    title: "QA tests",
    sections: [
      section(["tests_added"], "Tests added", "list"),
      section(["build_status"], "Build status"),
      section(["coverage_note"], "Coverage note"),
      section(["based_on_manual_qa"], "Based on manual QA"),
    ],
  },
  feature_spec: {
    title: "Feature spec",
    sections: [
      section(["goal"], "Goal"),
      section(["scope"], "Scope", "list"),
      section(["anti_scope"], "Anti-scope", "list"),
      section(["api_contract"], "API contract", "nested"),
      section(["acceptance_criteria"], "Acceptance criteria", "list"),
      section(["testing_strategy"], "Testing strategy"),
      section(["risks"], "Risks", "list"),
      section(["decisions"], "Decisions", "list"),
    ],
  },
  dod: {
    title: "Definition of Done",
    sections: [
      section(["items"], "Items", "table"),
      section(["contributions"], "Contributions", "nested"),
      section(["updated_at"], "Updated at"),
      section(["type_requirements_met"], "Type requirements met"),
    ],
  },
  cto_discovery: { title: "CTO discovery", sections: [section(["task"], "Task"), section(["branch"], "Branch"), section(["teams_hint"], "Teams hint", "list")] },
  team_plan: { title: "Team plan", sections: [section(["teams"], "Teams", "table"), section(["max_teams"], "Max teams"), section(["max_depth"], "Max depth")] },
  team_artifacts: { title: "Team artifacts", sections: [section(["teams"], "Teams", "table")] },
  integration_review: {
    title: "Integration review",
    sections: [section(["verdict"], "Verdict"), section(["findings"], "Findings", "list"), section(["merged_branches"], "Merged branches", "list"), section(["note"], "Note")],
  },
  lecture_intake: { title: "Lecture intake", sections: [section(["task"], "Task"), section(["sources"], "Sources", "table"), section(["constraints"], "Constraints", "list")] },
  lecture_mapping: { title: "Lecture mapping", sections: [section(["coverage"], "Coverage"), section(["lectures"], "Lectures", "table"), section(["gaps"], "Gaps", "list"), section(["sources_consulted"], "Sources consulted", "list")] },
  lecture_candidates: { title: "Lecture candidates", sections: [section(["candidates"], "Candidates", "table"), section(["deduped_count"], "Deduped count")] },
  lecture_repo_fit: { title: "Lecture repo fit", sections: [section(["findings"], "Findings", "table"), section(["verdict"], "Verdict"), section(["unverified_claims"], "Unverified claims", "list")] },
  lecture_decision: {
    title: "Lecture decision",
    sections: [section(["verdict"], "Verdict"), section(["rationale"], "Rationale"), section(["approved_candidates"], "Approved candidates", "list"), section(["next_steps"], "Next steps", "list")],
  },
};

// ── Shared section rendering ─────────────────────────────────────────────────

function scalarNodes(key: string, value: unknown, level: number): RenderNode[] {
  const lvl = clampLevel(level);
  if (value === null) return [kv(key, "null")];
  if (typeof value === "string") {
    if (value === "") return [kv(key, '""')];
    if (/[\r\n]/.test(value)) {
      const lines = value.split(/\r\n|\r|\n/).length;
      return [kv(key, `multi-line text (${lines} lines)`), code(value)];
    }
    return [kv(key, value)];
  }
  if (typeof value === "number" || typeof value === "boolean") return [kv(key, String(value))];
  // Objects/arrays nested under a scalar context → one bounded line.
  return [kv(key, compactValue(value))];
}

function scalarText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return boundedText(value);
  return String(value);
}

/** auto: shape-driven content — string → paragraph, string[] → list, object[] → table, object → nested. */
function autoNodes(value: unknown, level: number): RenderNode[] {
  const lvl = clampLevel(level);
  if (value === undefined) return [];
  if (value === null) return [kv("value", "null")];
  if (typeof value === "string") return value === "" ? [kv("value", '""')] : [p(boundedText(value))];
  if (typeof value === "number" || typeof value === "boolean") return [kv("value", String(value))];
  if (Array.isArray(value)) {
    if (value.length === 0) return [kv("items", "[]")];
    const allScalars = value.every((item) => item === null || typeof item !== "object");
    if (allScalars) return [list(value.map((item) => scalarText(item)))];
    const allObjects = value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
    if (allObjects) {
      const built = objectTable(value as Record<string, unknown>[]);
      return [built.node, ...(built.omittedColumns > 0 ? [p(`…[table: ${built.omittedColumns} more columns omitted]`)] : [])];
    }
    return [list(value.map((item) => compactValue(item)))];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [kv("fields", "{}")];
    const out: RenderNode[] = [];
    for (const [childKey, child] of entries) {
      if (child !== null && typeof child === "object") {
        out.push(h(lvl, humanize(childKey)));
        out.push(...autoNodes(child, lvl + 1));
      } else {
        out.push(...scalarNodes(childKey, child, lvl));
      }
    }
    return out;
  }
  return [kv("value", String(value))];
}

function listNodes(value: unknown, level: number): RenderNode[] {
  const lvl = clampLevel(level);
  if (Array.isArray(value)) {
    if (value.length === 0) return [kv("items", "[]")];
    const allScalars = value.every((item) => item === null || typeof item !== "object");
    if (allScalars) return [list(value.map((item) => scalarText(item)))];
    return [list(value.map((item) => compactValue(item)))];
  }
  return autoNodes(value, lvl);
}

function tableNodes(value: unknown, level: number): RenderNode[] {
  const lvl = clampLevel(level);
  if (Array.isArray(value) && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
    const built = objectTable(value as Record<string, unknown>[]);
    return [built.node, ...(built.omittedColumns > 0 ? [p(`…[table: ${built.omittedColumns} more columns omitted]`)] : [])];
  }
  return autoNodes(value, lvl);
}

function kvNodes(value: unknown, level: number): RenderNode[] {
  const lvl = clampLevel(level);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [kv("fields", "{}")];
    const out: RenderNode[] = [];
    for (const [childKey, child] of entries) out.push(...scalarNodes(childKey, child, lvl));
    return out;
  }
  return scalarNodes("value", value, lvl);
}

function nestedNodes(value: unknown, level: number): RenderNode[] {
  const lvl = clampLevel(level);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [kv("fields", "{}")];
    const out: RenderNode[] = [];
    for (const [childKey, child] of entries) {
      out.push(h(lvl, humanize(childKey)));
      out.push(...autoNodes(child, lvl + 1));
    }
    return out;
  }
  return autoNodes(value, lvl);
}

function renderSection(title: string, value: unknown, hint: SectionHint, level: number): RenderNode[] {
  const lvl = clampLevel(level);
  switch (hint) {
    case "list":
      return [h(lvl, title), ...listNodes(value, lvl + 1)];
    case "table":
      return [h(lvl, title), ...tableNodes(value, lvl + 1)];
    case "kv":
      return [h(lvl, title), ...kvNodes(value, lvl + 1)];
    case "nested":
      return [h(lvl, title), ...nestedNodes(value, lvl + 1)];
    default:
      return [h(lvl, title), ...autoNodes(value, lvl + 1)];
  }
}

// ── Shared structured pipeline ───────────────────────────────────────────────

function renderStructured(artifact: VisualizationArtifact, options: RenderOptions, presentation: ArtifactPresentation): RenderNode[] {
  const nodes: RenderNode[] = [h(ARTIFACT_HEADING_LEVEL, artifactHeading(artifact)), ...artifactMetaNodes(artifact)];
  const body = artifact.body;
  if (body === undefined || body.text === "") return nodes;
  const preview = bodyPreviewMarker(artifact);
  if (preview !== "") nodes.push(p(preview));
  if (body.text === EMPTY_BODY_MARKER || body.text === REDACTED_MARKER) {
    nodes.push(p(body.text));
    return nodes;
  }
  const parsed = parseBoundedJson(body.text, options.bounds);
  const marker = boundsMarkerOf(artifact, parsed);
  if (marker !== "") nodes.push(p(marker));
  if (!parsed.ok) {
    nodes.push(p(`not valid JSON — redacted raw text follows (parse error: ${parsed.parseError ?? "unknown"})`));
    nodes.push(code(body.text));
    return nodes;
  }
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    nodes.push(...renderJsonValue("", value, ARTIFACT_HEADING_LEVEL));
    return nodes;
  }
  nodes.push(p(presentation.title));
  // The model summary is shown only when the payload itself has no summary
  // section planned (avoid duplicating the same sentence).
  if (artifact.summary !== undefined && artifact.summary !== "" && !presentation.sections.some((s) => s.fields.includes("summary"))) {
    nodes.push(p(boundedText(artifact.summary)));
  }
  const record = value as Record<string, unknown>;
  const rendered = new Set<string>();
  for (const plan of presentation.sections) {
    for (const field of plan.fields) {
      if (field in record && record[field] !== undefined) {
        nodes.push(...renderSection(plan.title, record[field], plan.hint, 4));
        rendered.add(field);
        break;
      }
    }
  }
  // Remaining top-level fields in JSON parse order — nothing is dropped.
  for (const key of Object.keys(record)) {
    if (rendered.has(key) || key === "artifact_id" || key === "artifact_type") continue;
    nodes.push(...renderSection(humanize(key), record[key], "auto", 4));
  }
  return nodes;
}

// ── Public renderers ─────────────────────────────────────────────────────────

/**
 * Structured spec-family renderer for the 7 known spec-preparation ids.
 * Unknown spec ids return [] so the registry falls through to payload type
 * match / bounded generic fallback.
 */
export const renderSpecArtifact: ArtifactRenderer = (artifact, options: RenderOptions, _warnings: string[]): RenderNode[] => {
  const presentation = SPEC_PRESENTATIONS[artifact.id];
  if (presentation === undefined) return [];
  return renderStructured(artifact, options, presentation);
};

/** Structured schema renderer for the 22 typed schema ids. */
export const renderTypedArtifact: ArtifactRenderer = (artifact, options: RenderOptions, _warnings: string[]): RenderNode[] => {
  const presentation = TYPED_PRESENTATIONS[artifact.id];
  if (presentation === undefined) return renderStructured(artifact, options, { title: humanize(artifact.id), sections: [] });
  return renderStructured(artifact, options, presentation);
};
