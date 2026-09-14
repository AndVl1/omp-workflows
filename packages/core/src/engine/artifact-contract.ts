import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readPinnedArtifactSnapshot, validateArtifactStructure } from "./artifacts.js";
import { deepEqual } from "./predicate.js";
import { validateLectureAcquisitionArtifact } from "../lecture/acquisition.js";
import {
  isRecord,
  isSafeRelativePath,
  isSha256Hex,
  validateCompatibilityReport,
  validateCompatibilitySupplement,
  validateConstitutionBinding,
  validateExecutionClaim,
  validateFeatureWorkspaceRecord,
  validateImplementationConformance,
  validateImplementationHandoff,
  validateImportSnapshot,
} from "../specification/validation.js";
import type { Profile, StageDef, TeamState } from "./types.js";
import { PinnedRootError, type PinnedProjectRoot } from "../specification/pinned-root.js";

export interface JsonSchemaDef {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaDef>;
  items?: JsonSchemaDef;
  enum?: unknown[];
  const?: unknown;
  $defs?: Record<string, JsonSchemaDef>;
  $ref?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  prefixItems?: JsonSchemaDef[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchemaDef;
  description?: string;
  [keyword: string]: unknown;
}

const SUPPORTED_KEYWORDS = new Set([
  "type", "required", "properties", "items", "enum", "const", "$defs", "$ref", "minimum", "maximum",
  "minItems", "maxItems", "prefixItems", "minLength", "maxLength", "pattern", "additionalProperties", "description", "$schema", "$id", "title",
]);

const CANONICAL_ARTIFACT_SCHEMA_FIELDS: Record<string, readonly string[]> = {
  implementation_handoff: [
    "schema_version", "handoff_id", "handoff_digest", "feature_id", "source_kind",
    "artifact_versions", "scope", "requirements", "decisions", "tasks", "verification",
    "validation_refs", "approval_refs", "language", "constitution_binding",
    "constitution_impact_ref", "risks", "open_decisions", "execution_choices", "status",
    "import_snapshot_ref", "compatibility_supplement_ref", "import_framework",
    "import_mapping_id", "import_mapping_version", "import_selected_paths",
    "import_ignored_candidates", "import_intake_paths", "import_document_language",
    "import_document_language_source", "import_source_revision", "import_limits",
  ],
  execution_claim: [
    "claim_id", "handoff_digest", "owner_kind", "owner_run_id", "status", "acquired_at",
    "updated_at", "release_reason",
  ],
  implementation_conformance: [
    "schema_version", "conformance_id", "matrix_digest", "feature_id", "handoff_id",
    "handoff_digest", "execution_claim_id", "execution_owner", "execution_run_id",
    "profile_hash", "evaluated_at", "entries", "quality_gate_results", "overall_status",
    "blocking_findings", "next_action",
  ],
};
const CANONICAL_ARTIFACT_IDS = new Set(Object.keys(CANONICAL_ARTIFACT_SCHEMA_FIELDS));

export interface ArtifactIssue { field: string; message: string; }
export type ArtifactValidationResult = { ok: true } | { ok: false; issues: ArtifactIssue[] };
export interface ArtifactContractPolicy { validate: boolean; grandfathered: string[]; }
export const DEFAULT_ARTIFACT_CONTRACT_POLICY: ArtifactContractPolicy = { validate: true, grandfathered: [] };
let schemaCache: Record<string, JsonSchemaDef> | null = null;

const NATIVE_PHASE_DRAFT_IDS = ["specify_draft", "plan_draft", "task_graph"] as const;
const NATIVE_PHASE_FOR_DRAFT: Readonly<Record<string, "specify" | "plan" | "tasks">> = {
  specify_draft: "specify",
  plan_draft: "plan",
  task_graph: "tasks",
};
const NATIVE_PHASE_SECTION_KEYS: Readonly<Record<"specify" | "plan" | "tasks", readonly string[]>> = {
  specify: ["problem", "scope", "non_goals", "actors", "journeys", "requirements", "edge_cases", "assumptions", "dependencies", "success_criteria"],
  plan: ["repository_grounding", "decisions", "alternatives", "contracts", "data_flow", "control_flow", "migration", "security", "operations", "verification_strategy", "constitution_recheck"],
  tasks: ["task_graph", "dependencies", "expected_outcomes"],
};
const NATIVE_PHASE_STRING_MAX_LENGTH = 32_768;
const NATIVE_PHASE_ARRAY_MAX_ITEMS = 4_096;

/**
 * The native phase finalizer writes the complete semantic model projection,
 * not the historical minimal draft envelopes. Keep one executable schema for
 * all three profile artifact ids so stage completion and immutable persistence
 * cannot drift. Bounds mirror the native phase input limits.
 */
function boundedNativePhaseSchema(schema: JsonSchemaDef): JsonSchemaDef {
  const copy = structuredClone(schema) as JsonSchemaDef;
  const visit = (current: JsonSchemaDef): void => {
    if (current.type === "string" || (Array.isArray(current.type) && current.type.includes("string"))) {
      current.minLength ??= 1;
      current.maxLength ??= NATIVE_PHASE_STRING_MAX_LENGTH;
    }
    if (current.type === "array") current.maxItems ??= NATIVE_PHASE_ARRAY_MAX_ITEMS;
    for (const child of Object.values(current.properties ?? {})) visit(child);
    if (current.items) visit(current.items);
    for (const child of Object.values(current.$defs ?? {})) visit(child);
  };
  visit(copy);
  return copy;
}

export function loadArtifactSchemas(): Record<string, JsonSchemaDef> {
  if (schemaCache) return schemaCache;
  let defs: Record<string, JsonSchemaDef> = {};
  try {
    const here = fileURLToPath(import.meta.url);
    const path = join(resolve(here, "..", "..", ".."), "workflows", "artifacts-schema.json");
    if (existsSync(path)) {
      defs = (JSON.parse(readFileSync(path, "utf8")) as { definitions?: Record<string, JsonSchemaDef> }).definitions ?? {};
    }
  } catch {
    defs = {};
  }
  const phaseModel = defs.specification_phase_model;
  if (phaseModel) {
    const canonical = boundedNativePhaseSchema(phaseModel);
    defs.specification_phase_model = canonical;
    for (const id of NATIVE_PHASE_DRAFT_IDS) defs[id] = canonical;
  }
  schemaCache = defs;
  return defs;
}
function schemaIdForArtifact(id: string): string {
  if (loadArtifactSchemas()[id]) return id;
  for (const base of ["conformance_evidence", "quality_gate_evidence"] as const) {
    if (id.startsWith(`${base}-`) && id.length > base.length + 1) return base;
  }
  return id;
}

export function artifactSchemaFor(id: string): JsonSchemaDef | null {
  return loadArtifactSchemas()[schemaIdForArtifact(id)] ?? null;
}

export function requiredFieldsOf(id: string): string[] | null {
  const schema = artifactSchemaFor(id);
  return schema ? schema.required ?? [] : null;
}

export interface SpecificationPrincipleSchemaIdentity {
  principle_id: string;
  title: string;
}

/**
 * Bind the native phase output contract to the exact approved constitution
 * principle identities for this run. Dynamic rows retain worker-owned
 * applicability, status, and evidence while the engine owns identity, order,
 * and constitution binding.
 */
export interface SpecificationPhaseGenerationBinding {
  input_ref: string;
  input_digest: string;
}

export function specificationPhaseSchemaForConstitution(
  identities: readonly SpecificationPrincipleSchemaIdentity[],
  binding: unknown,
  phase?: "specify" | "plan" | "tasks",
  generation?: SpecificationPhaseGenerationBinding,
): JsonSchemaDef | null {
  if (!isRecord(binding) || Array.isArray(binding)) return null;
  if (Object.values(binding).some((value) => typeof value !== "string")) return null;
  const stringArray = (): JsonSchemaDef => ({ type: "array", items: { type: "string" } });
  const strictObject = (properties: Record<string, JsonSchemaDef>, required: readonly string[]): JsonSchemaDef => ({
    type: "object",
    additionalProperties: false,
    required: [...required],
    properties,
  });
  const phaseSections: Record<string, readonly string[]> = {
    specify: ["problem", "scope", "non_goals", "actors", "journeys", "requirements", "edge_cases", "assumptions", "dependencies", "success_criteria"],
    plan: ["repository_grounding", "decisions", "alternatives", "contracts", "data_flow", "control_flow", "migration", "security", "operations", "verification_strategy", "constitution_recheck"],
    tasks: ["task_graph", "dependencies", "expected_outcomes"],
  };
  const sectionsFor = (phase: string): JsonSchemaDef => {
    const keys = phaseSections[phase] ?? [];
    return strictObject(Object.fromEntries(keys.map((key) => [key, { type: "string", minLength: 1 }])) as Record<string, JsonSchemaDef>, keys);
  };
  const requirement = strictObject({
    requirement_id: { type: "string", minLength: 1 }, statement: { type: "string", minLength: 1 },
    acceptance_ids: stringArray(), source_refs: stringArray(), testable: { type: "boolean" }, untestable_reason: { type: ["string", "null"] },
  }, ["requirement_id", "statement", "acceptance_ids", "source_refs", "testable", "untestable_reason"]);
  const decision = strictObject({
    decision_id: { type: "string", minLength: 1 }, decision: { type: "string", minLength: 1 }, rationale: { type: "string", minLength: 1 }, requirement_ids: stringArray(),
  }, ["decision_id", "decision", "rationale", "requirement_ids"]);
  const task = strictObject({
    id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, requirement_ids: stringArray(), acceptance_ids: stringArray(), decision_ids: stringArray(), verification_ids: stringArray(), depends_on: stringArray(), expected_outcome: { type: "string", minLength: 1 }, affected_scope: stringArray(), completion_evidence: stringArray(), parallel_safe: { type: "boolean" },
  }, ["id", "title", "requirement_ids", "acceptance_ids", "decision_ids", "verification_ids", "depends_on", "expected_outcome", "affected_scope", "completion_evidence", "parallel_safe"]);
  const verification = strictObject({
    verification_id: { type: "string", minLength: 1 }, requirement_ids: stringArray(), acceptance_ids: stringArray(), task_ids: stringArray(), observable_behavior: { type: "boolean" }, expected_evidence: { type: "string", minLength: 1 },
  }, ["verification_id", "requirement_ids", "acceptance_ids", "task_ids", "observable_behavior", "expected_evidence"]);
  const contradiction = strictObject({
    contradiction_id: { type: "string", minLength: 1 }, subject_ids: stringArray(), status: { enum: ["resolved", "accepted", "unresolved"] }, assessment: { type: "string", minLength: 1 }, evidence: { type: "string", minLength: 1 },
  }, ["contradiction_id", "subject_ids", "status", "assessment", "evidence"]);
  const principle = strictObject({
    principle_id: { type: "string", enum: identities.map((identity) => identity.principle_id) }, applicability: { enum: ["applicable", "not_applicable"] }, status: { enum: ["pass", "fail", "not_applicable"] }, evidence: { type: "string", minLength: 1 },
  }, ["principle_id", "applicability", "status", "evidence"]);
  const inputRef: JsonSchemaDef = generation
    ? { type: "string", const: generation.input_ref }
    : { type: "string", minLength: 1, maxLength: 512, pattern: "^spec-native:[A-Za-z0-9._:-]+$" };
  const inputDigest: JsonSchemaDef = generation
    ? { type: "string", const: generation.input_digest }
    : { type: "string", pattern: "^[a-f0-9]{64}$" };
  const properties: Record<string, JsonSchemaDef> = {
    input_ref: inputRef,
    input_digest: inputDigest,
    sections: sectionsFor(phase ?? "specify"),
    requirements: { type: "array", items: requirement }, decisions: { type: "array", items: decision }, tasks: { type: "array", items: task },
    verification: { type: "array", items: verification }, contradictions: { type: "array", items: contradiction },
    constitution_principles: { type: "array", minItems: identities.length, maxItems: identities.length, items: principle },
  };
  return strictObject(properties, Object.keys(properties));
}

type SpecificationArtifactValidator = (value: unknown) => string[];
function validatedIssues(result: { ok: true } | { ok: false; issues: string[] }): string[] {
  return result.ok ? [] : result.issues;
}
const SPECIFICATION_ARTIFACT_VALIDATORS: Record<string, SpecificationArtifactValidator> = {
  feature_workspace: (value) => validatedIssues(validateFeatureWorkspaceRecord(value)),
  constitution_record: (value) => validateConstitutionBinding(value),
  implementation_handoff: (value) => validatedIssues(validateImplementationHandoff(value)),
  execution_claim: (value) => validatedIssues(validateExecutionClaim(value)),
  implementation_conformance: (value) => validatedIssues(validateImplementationConformance(value)),
  import_snapshot: (value) => validatedIssues(validateImportSnapshot(value)),
  compatibility_report: (value) => validatedIssues(validateCompatibilityReport(value)),
  compatibility_supplement: (value) => validatedIssues(validateCompatibilitySupplement(value)),
};

function appendCanonicalIssues(id: string, value: unknown, issues: ArtifactIssue[]): void {
  const validator = SPECIFICATION_ARTIFACT_VALIDATORS[id];
  if (validator) {
    for (const issue of validator(value)) {
      const split = issue.indexOf(" ");
      issues.push({ field: issue.startsWith("$") && split > 1 ? issue.slice(0, split) : "$", message: issue });
    }
  }
  if (id === "implementation_handoff") appendHandoffReferenceIssues(value, issues);
  if (id === "implementation_conformance") appendConformanceReferenceIssues(value, issues);
  if (id === "specification_phase_version") appendMaterializationReferenceIssues(value, issues);
}

function appendSpecialIssues(id: string, value: unknown, issues: ArtifactIssue[]): void {
  if (id === "lecture_acquisition") {
    issues.push(...validateLectureAcquisitionArtifact(value, { requireBinding: true }));
  }
  if (id === "manual_qa") issues.push(...validateManualQaArtifact(value));
}

const CONDITIONAL_CANONICAL_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  implementation_handoff: [
    "import_framework",
    "import_mapping_id",
    "import_mapping_version",
    "import_selected_paths",
    "import_ignored_candidates",
    "import_intake_paths",
    "import_document_language",
    "import_document_language_source",
    "import_source_revision",
    "import_limits",
  ],
});

function canonicalSchemaIssues(id: string, schema: JsonSchemaDef | null): string[] {
  if (!CANONICAL_ARTIFACT_IDS.has(id)) return [];
  if (!schema || schema.type !== "object" || schema.additionalProperties !== false || !schema.properties) {
    return [`artifact '${id}' has a missing or mismatched strict executable schema`];
  }
  const required = new Set(schema.required ?? []);
  const conditional = new Set(CONDITIONAL_CANONICAL_FIELDS[id] ?? []);
  const missing = CANONICAL_ARTIFACT_SCHEMA_FIELDS[id]!.filter((field) =>
    (!conditional.has(field) && !required.has(field)) || !schema.properties![field]);
  return missing.length === 0
    ? []
    : [`artifact '${id}' schema is missing canonical fields: ${missing.join(", ")}`];
}

export function validateProducedArtifact(
  id: string,
  value: unknown,
  policy: ArtifactContractPolicy = DEFAULT_ARTIFACT_CONTRACT_POLICY,
  schemaOverride?: JsonSchemaDef,
): ArtifactValidationResult {
  const structure = validateArtifactStructure(value);
  if (!structure.ok) return { ok: false, issues: [{ field: "$", message: structure.error }] };
  if (!policy.validate || policy.grandfathered.includes(id)) return { ok: true };
  const schema = schemaOverride ?? artifactSchemaFor(id);
  const schemaIssues = schemaOverride === undefined ? canonicalSchemaIssues(id, schema) : [];
  if (schemaIssues.length > 0) return { ok: false, issues: schemaIssues.map((message) => ({ field: "$", message })) };
  if (!schema) return { ok: true };
  const issues: ArtifactIssue[] = [];
  validateValue(schema, value, "$", issues, `artifact '${id}'`);
  appendSpecialIssues(id, value, issues);
  appendCanonicalIssues(id, value, issues);
  if (schemaOverride === undefined) appendNativePhaseModelIssues(id, value, issues);
  return issues.length ? { ok: false, issues } : { ok: true };
}

export function validateManualQaArtifact(value: unknown): ArtifactIssue[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const artifact = value as Record<string, unknown>;
  if (artifact.verdict !== "CONDITIONAL") return [];
  const blockers = artifact.blocked_prerequisites;
  if (!Array.isArray(blockers) || blockers.length === 0) {
    return [{ field: "$.blocked_prerequisites", message: "manual_qa CONDITIONAL requires at least one blocked prerequisite" }];
  }
  const empty = blockers.findIndex((blocker) => typeof blocker === "string" && blocker.trim() === "");
  return empty >= 0
    ? [{ field: `$.blocked_prerequisites[${empty}]`, message: "manual_qa blocked prerequisites must be non-empty strings" }]
    : [];
}

function appendNativePhaseModelIssues(id: string, value: unknown, issues: ArtifactIssue[]): void {
  if (id !== "specification_phase_model" && !NATIVE_PHASE_DRAFT_IDS.includes(id as (typeof NATIVE_PHASE_DRAFT_IDS)[number])) return;
  if (!isRecord(value)) return;
  const expectedPhase = NATIVE_PHASE_FOR_DRAFT[id];
  const phase = value.phase;
  if (expectedPhase && phase !== expectedPhase) {
    issues.push({ field: "$.phase", message: `artifact '${id}' must declare phase '${expectedPhase}'` });
    return;
  }
  if (phase !== "specify" && phase !== "plan" && phase !== "tasks") return;
  const sections = value.sections;
  if (!isRecord(sections)) return;
  const expected = new Set(NATIVE_PHASE_SECTION_KEYS[phase]);
  for (const key of Object.keys(sections)) {
    if (!expected.has(key)) issues.push({ field: `$.sections.${key}`, message: `artifact '${id}' contains a section that is not valid for phase '${phase}'` });
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(sections, key)) {
      issues.push({ field: `$.sections.${key}`, message: `artifact '${id}' is missing the required '${phase}' phase section` });
    }
  }
}

export interface ConsumeDiagnostic { id: string; missing: boolean; producer_status: string | null; issues: ArtifactIssue[]; }
export type ConsumeValidationResult =
  | { ok: true; diagnostics: ConsumeDiagnostic[] }
  | { ok: false; error: string; diagnostics: ConsumeDiagnostic[] };
export interface ConsumedArtifactReadContext {
  /** Read through the same descriptor-anchored root held by the caller. */
  pinnedRoot: PinnedProjectRoot;
  /** Artifact directory relative to the pinned project root. */
  artifactsDirRelative: string;
  /** Capture successfully read values for the renderer using the same snapshot. */
  capture?: Record<string, unknown>;
}


export function validateConsumedArtifacts(
  stage: StageDef,
  artifactsDir: string,
  state: TeamState,
  profile: Profile | null,
  policy: ArtifactContractPolicy = DEFAULT_ARTIFACT_CONTRACT_POLICY,
  readContext?: ConsumedArtifactReadContext,
): ConsumeValidationResult {
  const diagnostics: ConsumeDiagnostic[] = [];
  const producerStatus = new Map<string, string | null>();
  if (profile) {
    for (const candidate of profile.stages) {
      for (const id of producesOf(candidate)) {
        producerStatus.set(id, state.stages.find((entry) => entry.id === candidate.id)?.status ?? "pending");
      }
    }
  }
  for (const id of stage.consumes ?? []) {
    const status = producerStatus.get(id) ?? null;
    if (!policy.validate || policy.grandfathered.includes(id)) {
      diagnostics.push({ id, missing: false, producer_status: status, issues: [] });
      continue;
    }
    const schema = artifactSchemaFor(id);
    const schemaIssues = canonicalSchemaIssues(id, schema);
    if (schemaIssues.length > 0) {
      diagnostics.push({ id, missing: false, producer_status: status, issues: schemaIssues.map((message) => ({ field: "$", message })) });
      continue;
    }
    if (!schema) {
      diagnostics.push({ id, missing: false, producer_status: status, issues: [] });
      continue;
    }
    let value: unknown;
    let failure: { kind: "missing" | "unreadable"; reason: string } | null = null;
    if (readContext) {
      try {
        value = readPinnedArtifactSnapshot(readContext.pinnedRoot, readContext.artifactsDirRelative, id).value;
      } catch (error) {
        failure = {
          kind: error instanceof PinnedRootError && error.code === "not_found" ? "missing" : "unreadable",
          reason: error instanceof Error ? error.message : "artifact could not be read through the pinned project root",
        };
      }
    } else {
      failure = { kind: "unreadable", reason: "artifact read requires a pinned project root" };
    }
    if (failure) {
      const missing = failure.kind === "missing" && status === "done";
      const issues = failure.kind === "missing"
        ? (missing ? [{ field: "$", message: `consumed artifact '${id}.json' is missing while its producing stage is done` }] : [])
        : [{ field: "$", message: `consumed artifact '${id}.json' could not be read: ${failure.reason}` }];
      diagnostics.push({ id, missing, producer_status: status, issues });
      continue;
    }
    // Both read paths assign value before reaching validation; keep the
    // assertion local so TypeScript does not widen the branch above.
    if (value === undefined) {
      diagnostics.push({ id, missing: false, producer_status: status, issues: [{ field: "$", message: `consumed artifact '${id}.json' could not be read` }] });
      continue;
    }
    readContext?.capture && (readContext.capture[id] = value);
    const issues: ArtifactIssue[] = [];
    validateValue(schema, value, "$", issues, `artifact '${id}'`);
    appendSpecialIssues(id, value, issues);
    appendCanonicalIssues(id, value, issues);
    appendNativePhaseModelIssues(id, value, issues);
    diagnostics.push({ id, missing: false, producer_status: status, issues });
  }
  const blocking = diagnostics.filter((diagnostic) => diagnostic.issues.length > 0);
  return blocking.length
    ? { ok: false, error: formatConsumeIssues(blocking), diagnostics }
    : { ok: true, diagnostics };
}

function formatConsumeIssues(diagnostics: ConsumeDiagnostic[]): string {
  return `consumed artifact contract violation(s): ${diagnostics.map((diagnostic) => `${diagnostic.id}: ${diagnostic.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`).join(" | ")}`;
}
function producesOf(stage: StageDef): string[] {
  return Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
}

interface ValidationFrame {
  schema: JsonSchemaDef;
  value: unknown;
  path: string;
}

function resolveSchemaReference(root: JsonSchemaDef, schema: JsonSchemaDef, path: string, issues: ArtifactIssue[], where: string): JsonSchemaDef | null {
  const reference = schema.$ref;
  if (reference === undefined) return schema;
  if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) {
    issues.push({ field: path, message: `${where}: unsupported schema reference '${String(reference)}'` });
    return null;
  }
  const name = reference.slice("#/$defs/".length);
  const target = root.$defs?.[name];
  if (!target) {
    issues.push({ field: path, message: `${where}: unresolved schema reference '${reference}'` });
    return null;
  }
  const local = { ...schema };
  delete local.$ref;
  const mergedProperties = target.properties && local.properties
    ? { ...target.properties, ...local.properties }
    : local.properties ?? target.properties;
  return {
    ...target,
    ...local,
    ...(mergedProperties === undefined ? {} : { properties: mergedProperties }),
  };
}

function validateValue(schema: JsonSchemaDef, value: unknown, path: string, issues: ArtifactIssue[], where: string): void {
  const stack: ValidationFrame[] = [{ schema, value, path }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const currentSchema = resolveSchemaReference(schema, frame.schema, frame.path, issues, where);
    if (!currentSchema) continue;
    const currentValue = frame.value;
    const currentPath = frame.path;
    for (const keyword of Object.keys(currentSchema)) {
      if (!SUPPORTED_KEYWORDS.has(keyword)) {
        issues.push({ field: currentPath, message: `${where}: unsupported schema keyword '${keyword}' — refusing partial validation` });
        continue;
      }
    }
    if (Object.keys(currentSchema).some((keyword) => !SUPPORTED_KEYWORDS.has(keyword))) continue;
    if (currentSchema.type !== undefined) {
      const types = Array.isArray(currentSchema.type) ? currentSchema.type : [currentSchema.type];
      if (!types.some((type) => matchesType(type, currentValue))) {
        issues.push({ field: currentPath, message: `${where}: expected type ${types.join("|")}, got ${describeValue(currentValue)}` });
        continue;
      }
    }
    if (currentSchema.enum !== undefined && !currentSchema.enum.some((candidate) => deepEqual(candidate, currentValue))) {
      issues.push({ field: currentPath, message: `${where}: value is not one of the schema enum values` });
    }
    if (currentSchema.const !== undefined && !deepEqual(currentSchema.const, currentValue)) {
      issues.push({ field: currentPath, message: `${where}: value does not match the schema const value` });
    }
    if (currentSchema.minimum !== undefined && typeof currentValue === "number" && currentValue < currentSchema.minimum) {
      issues.push({ field: currentPath, message: `${where}: ${currentValue} is below minimum ${currentSchema.minimum}` });
    }
    if (currentSchema.maximum !== undefined && typeof currentValue === "number" && currentValue > currentSchema.maximum) {
      issues.push({ field: currentPath, message: `${where}: ${currentValue} is above maximum ${currentSchema.maximum}` });
    }
    if (currentSchema.minLength !== undefined && typeof currentValue === "string" && currentValue.length < currentSchema.minLength) {
      issues.push({ field: currentPath, message: `${where}: string has ${currentValue.length} characters, minimum is ${currentSchema.minLength}` });
    }
    if (currentSchema.maxLength !== undefined && typeof currentValue === "string" && currentValue.length > currentSchema.maxLength) {
      issues.push({ field: currentPath, message: `${where}: string has ${currentValue.length} characters, maximum is ${currentSchema.maxLength}` });
    }
    if (currentSchema.pattern !== undefined && typeof currentValue === "string") {
      let patternValid = true;
      let matches = false;
      try {
        matches = new RegExp(currentSchema.pattern, "u").test(currentValue);
      } catch {
        patternValid = false;
        issues.push({ field: currentPath, message: `${where}: schema pattern is invalid` });
      }
      if (patternValid && !matches) issues.push({ field: currentPath, message: `${where}: string does not match the schema pattern` });
    }
    if (currentSchema.minItems !== undefined && Array.isArray(currentValue) && currentValue.length < currentSchema.minItems) {
      issues.push({ field: currentPath, message: `${where}: array has ${currentValue.length} items, minimum is ${currentSchema.minItems}` });
    }
    if (currentSchema.maxItems !== undefined && Array.isArray(currentValue) && currentValue.length > currentSchema.maxItems) {
      issues.push({ field: currentPath, message: `${where}: array has ${currentValue.length} items, maximum is ${currentSchema.maxItems}` });
    }
    if (Array.isArray(currentValue)) {
      const prefixItems = currentSchema.prefixItems ?? [];
      for (let index = Math.min(prefixItems.length, currentValue.length) - 1; index >= 0; index -= 1) {
        stack.push({ schema: prefixItems[index]!, value: currentValue[index], path: `${currentPath}[${index}]` });
      }
      if (currentSchema.items) {
        for (let index = currentValue.length - 1; index >= 0; index -= 1) {
          stack.push({ schema: currentSchema.items, value: currentValue[index], path: `${currentPath}[${index}]` });
        }
      }
      continue;
    }
    if (currentValue && typeof currentValue === "object" && !Array.isArray(currentValue)) {
      const record = currentValue as Record<string, unknown>;
      for (const required of currentSchema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, required)) {
          issues.push({ field: `${currentPath}.${required}`, message: `${where}: required field '${required}' is missing` });
        }
      }
      const properties = Object.entries(currentSchema.properties ?? {});
      for (let index = properties.length - 1; index >= 0; index -= 1) {
        const [key, child] = properties[index]!;
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          stack.push({ schema: child, value: record[key], path: `${currentPath}.${key}` });
        }
      }
      const additional = currentSchema.additionalProperties;
      const known = new Set(Object.keys(currentSchema.properties ?? {}));
      if (additional === false) {
        for (const key of Object.keys(record)) {
          if (!known.has(key)) issues.push({ field: `${currentPath}.${key}`, message: `${where}: unknown field '${key}' is not allowed` });
        }
      } else if (additional && typeof additional === "object") {
        const recordEntries = Object.entries(record);
        for (let index = recordEntries.length - 1; index >= 0; index -= 1) {
          const [key, childValue] = recordEntries[index]!;
          if (!known.has(key)) stack.push({ schema: additional, value: childValue, path: `${currentPath}.${key}` });
        }
      }
    }
  }
}

function validateArtifactReference(value: unknown, path: string, issues: ArtifactIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ field: path, message: `${path} must be a strict completion artifact reference object` });
    return;
  }
  const expected = ["artifact_id", "path", "sha256", "size_bytes", "schema_status", "quality_gate_status"];
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) issues.push({ field: `${path}.${key}`, message: `${path} contains an unknown artifact-reference field` });
  }
  if (typeof value.artifact_id !== "string" || value.artifact_id.trim() === "") issues.push({ field: `${path}.artifact_id`, message: "artifact reference artifact_id must be a non-empty string" });
  if (!isSafeRelativePath(value.path)) issues.push({ field: `${path}.path`, message: "artifact reference path must be a safe project-relative path" });
  if (!isSha256Hex(value.sha256)) issues.push({ field: `${path}.sha256`, message: "artifact reference sha256 must be a 64-char sha256 hex digest" });
  if (value.size_bytes !== undefined && (typeof value.size_bytes !== "number" || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0)) issues.push({ field: `${path}.size_bytes`, message: "artifact reference size_bytes must be a non-negative safe integer" });
  if (value.schema_status !== "met" && value.schema_status !== "failed") issues.push({ field: `${path}.schema_status`, message: "artifact reference schema_status must be met or failed" });
  if (value.quality_gate_status !== "met" && value.quality_gate_status !== "pending" && value.quality_gate_status !== "failed") issues.push({ field: `${path}.quality_gate_status`, message: "artifact reference quality_gate_status is invalid" });
}

function appendHandoffReferenceIssues(value: unknown, issues: ArtifactIssue[]): void {
  if (!isRecord(value)) return;
  const requirements = value.requirements;
  if (Array.isArray(requirements)) {
    requirements.forEach((requirement, index) => {
      if (!isRecord(requirement) || !Array.isArray(requirement.source_refs)) return;
      requirement.source_refs.forEach((ref, refIndex) => {
        const path = typeof ref === "string" ? ref.split("#", 1)[0] : ref;
        if (!isSafeRelativePath(path)) issues.push({ field: `$.requirements[${index}].source_refs[${refIndex}]`, message: "handoff source reference must be safe and project-relative" });
      });
    });
  }
}

function appendConformanceReferenceIssues(value: unknown, issues: ArtifactIssue[]): void {
  if (!isRecord(value)) return;
  if (Array.isArray(value.entries)) {
    value.entries.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      for (const field of ["implementation_evidence_refs", "review_evidence_refs"]) {
        if (Array.isArray(entry[field])) entry[field].forEach((ref, refIndex) => validateArtifactReference(ref, `$.entries[${index}].${field}[${refIndex}]`, issues));
      }
      if (Array.isArray(entry.test_evidence)) {
        entry.test_evidence.forEach((test, testIndex) => {
          if (isRecord(test)) validateArtifactReference(test.evidence_ref, `$.entries[${index}].test_evidence[${testIndex}].evidence_ref`, issues);
        });
      }
    });
  }
  if (Array.isArray(value.quality_gate_results)) {
    value.quality_gate_results.forEach((gate, index) => {
      if (!isRecord(gate)) return;
      if (Array.isArray(gate.evidence_refs)) gate.evidence_refs.forEach((ref, refIndex) => validateArtifactReference(ref, `$.quality_gate_results[${index}].evidence_refs[${refIndex}]`, issues));
    });
  }
}

function appendMaterializationReferenceIssues(value: unknown, issues: ArtifactIssue[]): void {
  if (!isRecord(value) || !Array.isArray(value.document_paths)) return;
  value.document_paths.forEach((path, index) => {
    if (!isSafeRelativePath(path)) issues.push({ field: `$.document_paths[${index}]`, message: "materialized document path must be safe and project-relative" });
  });
  if (isRecord(value.document_hashes)) {
    for (const path of Object.keys(value.document_hashes)) {
      if (!isSafeRelativePath(path)) issues.push({ field: `$.document_hashes.${path}`, message: "materialized document hash key must be safe and project-relative" });
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return false;
  }
}
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
