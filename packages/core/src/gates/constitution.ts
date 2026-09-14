/**
 * Deterministic, local-only constitution usability gate (T019).
 *
 * Pure classification over resolved constitution bytes: no filesystem, no
 * network, no external command. Every blocking outcome carries an explicit
 * reason; warnings never block. The prerequisite consumes `status`, while
 * `detail` preserves the canonical fine-grained ConstitutionUsabilityStatus.
 */
import type { ConstitutionUsabilityStatus } from "../specification/types.js";

export interface ConstitutionUsabilityResult {
  /** Gate-level outcome consumed by the prerequisite and callers. */
  status: "usable" | "constitution_required";
  /** Canonical fine-grained usability classification. */
  detail: ConstitutionUsabilityStatus;
  /** Mandatory human-readable reason for every blocking classification. */
  reason: string | null;
  /** Visible but non-blocking observations. */
  warnings: string[];
}

const UNRESOLVED_TEMPLATE_RE = /\{\{[^{}]{0,256}\}\}/;
const VERSION_LABEL_RE = /^Version:\s*\S+/im;
const ATX_HEADING_RE = /^#{1,6}\s+\S/;
const SECTION_HEADING_RE = /^#{2,6}\s+\S/;

/**
 * Classify a constitution document. A document is usable only when it is
 * present, non-empty, free of unresolved template markers, and structurally
 * valid (a title heading plus at least one principle section). A missing
 * version label degrades to a warning, never a structural failure.
 */
export function evaluateConstitutionUsability(document: string | null | undefined): ConstitutionUsabilityResult {
  if (document === null || document === undefined) {
    return {
      status: "constitution_required",
      detail: "missing",
      reason: "no constitution document resolved at the selected provider path",
      warnings: [],
    };
  }
  if (typeof document !== "string" || document.trim().length === 0) {
    return {
      status: "constitution_required",
      detail: "empty",
      reason: "the constitution document is empty or whitespace",
      warnings: [],
    };
  }
  if (UNRESOLVED_TEMPLATE_RE.test(document)) {
    return {
      status: "constitution_required",
      detail: "unresolved_template",
      reason: "the constitution contains unresolved template markers",
      warnings: [],
    };
  }
  const lines = document.split("\n");
  const hasTitle = lines.some((line) => ATX_HEADING_RE.test(line));
  const hasSection = lines.some((line) => SECTION_HEADING_RE.test(line));
  if (!hasTitle || !hasSection) {
    return {
      status: "constitution_required",
      detail: "structurally_invalid",
      reason: "the constitution must carry a title heading and at least one principle section",
      warnings: [],
    };
  }
  const warnings: string[] = [];
  if (!VERSION_LABEL_RE.test(document)) {
    warnings.push("no `Version:` label found; the constitution version is recorded as 0.0.0");
  }
  return { status: "usable", detail: "usable", reason: null, warnings };
}
