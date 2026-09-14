/**
 * Reusable specification validation (T018).
 *
 * Pure, dependency-free validators and checks shared by the durable engine
 * (fail-closed embedded-aggregate validation), the specification workspace
 * resolver, and later phase/conformance consumers:
 *
 *   - deterministic hashing helpers (content, semantic-section, canonical JSON)
 *   - strict structural validators for the canonical aggregate records
 *   - traceability completeness checks with actionable findings
 *   - typed next-action derivation for the readable projection
 *
 * This module MUST stay pure: no engine imports, no filesystem access, no
 * wall-clock reads. Timestamps and digests are inputs, never generated here.
 */
import { createHash } from "node:crypto";
import type {
  CompatibilitySupplement,
  ExecutionClaim,
  FeatureWorkspace,
  ProjectRootIdentity,
  WorkspacePathBinding,
  WorkspacePathIdentity,
  HandoffDecision,
  HandoffRequirement,
  HandoffVerification,
  ImplementationConformanceResult,
  ImplementationHandoff,
  ImplementationTask,
  ConstitutionBinding,
  ConstitutionPrincipleResult,
  PhaseValidationResult,
  TraceabilitySummary,
  ValidationCheck,
  ValidationFinding,
  WorkspaceNextAction,
  WorkspacePhaseRecord,
  WorkspaceStatus,
} from "./types.js";

// ── Hashing helpers ──────────────────────────────────────────────────────────

/** SHA-256 hex digest of exact bytes. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Deterministic canonical JSON (object keys sorted); the digest input everywhere. */
export function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 hex digest of the canonical JSON of a value. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Exact typed envelope used by every compatibility-supplement hash/check. */
export type CompatibilitySupplementEnvelope = {
  schema_version: 1;
  feature_id: string;
  snapshot_id: string;
  snapshot_ref: string;
  source_sha256: string;
  framework: string;
  mapping_id: string;
  mapping_version: string;
  semantic_rows: CompatibilitySupplement["semantic_rows"];
  sections: CompatibilitySupplement["sections"];
  approved_by_ref: string;
  approved_at: string;
};

export function compatibilitySupplementEnvelope(
  value: Pick<CompatibilitySupplement, keyof CompatibilitySupplementEnvelope>,
): CompatibilitySupplementEnvelope {
  return {
    schema_version: value.schema_version,
    feature_id: value.feature_id,
    snapshot_id: value.snapshot_id,
    snapshot_ref: value.snapshot_ref,
    source_sha256: value.source_sha256,
    framework: value.framework,
    mapping_id: value.mapping_id,
    mapping_version: value.mapping_version,
    semantic_rows: value.semantic_rows,
    sections: value.sections,
    approved_by_ref: value.approved_by_ref,
    approved_at: value.approved_at,
  };
}

export function compatibilitySupplementContentHash(
  value: Pick<CompatibilitySupplement, keyof CompatibilitySupplementEnvelope>,
): string {
  return digestOf(compatibilitySupplementEnvelope(value));
}

export function compatibilitySupplementId(
  value: Pick<CompatibilitySupplement, keyof CompatibilitySupplementEnvelope>,
): string {
  const envelope = compatibilitySupplementEnvelope(value);
  return `supplement.${digestOf(envelope)}`;
}

/**
 * Compute the content address of an implementation-conformance matrix.
 * Identity fields and evaluation time are metadata; every other canonical
 * matrix field is authoritative and therefore participates in this digest.
 */
export function implementationConformanceMatrixDigest(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return digestOf({
    schema_version: value.schema_version,
    feature_id: value.feature_id,
    handoff_id: value.handoff_id,
    handoff_digest: value.handoff_digest,
    execution_claim_id: value.execution_claim_id,
    execution_owner: value.execution_owner,
    execution_run_id: value.execution_run_id,
    profile_hash: value.profile_hash,
    entries: value.entries,
    quality_gate_results: value.quality_gate_results,
    overall_status: value.overall_status,
    blocking_findings: value.blocking_findings,
    next_action: value.next_action,
  });
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * External-origin metadata must never carry a new line, terminal/control
 * character, or invisible directional/formatting mark. `Cf` includes bidi
 * controls and common zero-width characters; line and paragraph separators
 * are included explicitly because they break line-oriented prompt records.
 */
const UNSAFE_EXTERNAL_METADATA_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SAFE_CANONICAL_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const MIGRATION_RECEIPT_ID_RE = /^migration-[a-f0-9]{24}$/u;
const CANONICAL_LANGUAGE_RE = /^(?:[a-z]{2,8})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?(?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*(?:-x(?:-[a-z0-9]{1,8})+)?$/;

/** Bounded, line-inert external metadata predicate shared by import gates. */
export function isSafeExternalMetadata(value: unknown, maxLength = 1024): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !UNSAFE_EXTERNAL_METADATA_RE.test(value);
}

/** Strict ASCII token used for recognizer ids and other prompt metadata. */
export function isSafeCanonicalToken(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CANONICAL_TOKEN_RE.test(value);
}

/** Recognizers may report only normalized source-root-relative paths. */
function isSafeRecognizerPath(value: unknown): value is string {
  return isSafeRelativePath(value);
}
const IMPORT_MAX_PATH_AGGREGATE_BYTES = 512 * 1024;
const IMPORT_LIMIT_MAXIMUMS = Object.freeze({
  maxFiles: 512,
  maxBytes: 32 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxTextBytes: 32 * 1024 * 1024,
  maxBinaryBytes: 4 * 1024 * 1024,
  maxDirectoryEntries: 8192,
  maxHeadings: 8192,
  maxRequirements: 2048,
  maxTasks: 4096,
  maxDecisions: 2048,
  maxDependencies: 8192,
  maxMappings: 16384,
  maxFindings: 8192,
  maxWork: 1_048_576,
});
const IMPORT_LIMIT_KEYS = Object.freeze(Object.keys(IMPORT_LIMIT_MAXIMUMS)) as ReadonlyArray<keyof typeof IMPORT_LIMIT_MAXIMUMS>;

/** Validate the exact normalized import ceiling object persisted in artifacts. */
export function validateImportLimits(value: unknown, path = "$.limits"): { ok: true } | { ok: false; issues: string[] } {
  if (!isRecord(value)) return { ok: false, issues: [`${path} must be an object`] };
  const issues: string[] = [];
  unknownKeys(value, IMPORT_LIMIT_KEYS, path, issues);
  for (const key of IMPORT_LIMIT_KEYS) {
    const candidate = value[key];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > IMPORT_LIMIT_MAXIMUMS[key]) {
      issues.push(`${path}.${key} must be a positive safe integer no greater than ${IMPORT_LIMIT_MAXIMUMS[key]}`);
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function validateSafePathArray(
  value: unknown,
  path: string,
  issues: string[],
  options: { maxEntries?: number; allowDot?: boolean } = {},
): value is string[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of safe project paths`);
    return false;
  }
  const maxEntries = options.maxEntries ?? IMPORT_MAX_FILES;
  if (value.length > maxEntries) issues.push(`${path} exceeds the ${maxEntries}-entry bound`);
  const seen = new Set<string>();
  let aggregateBytes = 0;
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    const valid = options.allowDot === true && entry === "." ? true : isSafeRelativePath(entry);
    if (!valid) {
      issues.push(`${entryPath} must be a safe source-root-relative path`);
      continue;
    }
    aggregateBytes += Buffer.byteLength(entry, "utf8");
    if (seen.has(entry)) issues.push(`${path} must not contain duplicate paths`);
    seen.add(entry);
  }
  if (aggregateBytes > IMPORT_MAX_PATH_AGGREGATE_BYTES) {
    issues.push(`${path} exceeds the ${IMPORT_MAX_PATH_AGGREGATE_BYTES}-byte aggregate path bound`);
  }
  return true;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

/**
 * Safe project-relative path: single rooted-relative POSIX form, no `..`,
 * no absolute or drive segments, no backslashes or NUL. Segment-level
 * containment against a real filesystem root is enforced by callers with
 * realpath checks; this predicate is the static first gate.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (!isSafeExternalMetadata(value)) return false;
  if (value.includes("\\")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  if (value.includes("//")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Safe feature id: immutable single directory component, branch-independent.
 * Lowercase `[a-z0-9._-]`, 1..128 chars, never `.` or `..`, must start with
 * `[a-z0-9]` so no hidden or separator-led component is addressable.
 */
export function isSafeFeatureId(featureId: unknown): featureId is string {
  return typeof featureId === "string"
    && featureId.length >= 1
    && featureId.length <= 128
    && featureId !== "." && featureId !== ".."
    && /^[a-z0-9][a-z0-9._-]*$/.test(featureId);
}

// ── Semantic section markers and hashes ──────────────────────────────────────

/** Canonical semantic marker directive embedded in every specification template. */
export const SEMANTIC_MARKER_DIRECTIVE_PREFIX = "<!-- omp-spec:marker:" as const;

const SEMANTIC_MARKER_RE = /^<!--\s*omp-spec:marker:([a-z0-9_-]+)\s*-->$/;

/** Extract stable semantic marker ids from a Markdown document, in order. */
export function extractSemanticMarkers(markdown: string): string[] {
  const markers: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = SEMANTIC_MARKER_RE.exec(line.trim());
    if (match && !markers.includes(match[1]!)) markers.push(match[1]!);
  }
  return markers;
}

/**
 * SHA-256 per semantic section. A section spans from its marker directive to
 * the next marker directive or end of document; content is whitespace-
 * normalized so formatting-only edits keep the same hash while any semantic
 * change (including localized heading text changes inside the section) does not.
 */
export function semanticSectionHashes(markdown: string, markers: readonly string[]): Record<string, string> {
  const lines = markdown.split("\n");
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const match = SEMANTIC_MARKER_RE.exec(line.trim());
    if (match) {
      current = match[1]!;
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current)!.push(line);
  }
  const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
  const hashes: Record<string, string> = {};
  for (const marker of markers) {
    const section = sections.get(marker);
    hashes[marker] = sha256Hex(section ? normalize(section.join("\n")) : "");
  }
  return hashes;
}

// ── Strict record validation ─────────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>;

/** Canonical object guard for the specification subsystem (shared, exported). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
// Handoff validation is an untrusted-input boundary. Keep all ceilings here
// rather than relying on the downstream artifact/import limits: a frozen
// handoff can be supplied directly by a caller.
export const MAX_HANDOFF_ARRAY_ITEMS = 4_096;
export const MAX_HANDOFF_STRING_BYTES = 8_192;
export const MAX_HANDOFF_AGGREGATE_BYTES = 4 * 1024 * 1024;
export const MAX_HANDOFF_VALIDATION_DEPTH = 256;
export const MAX_HANDOFF_VALIDATION_WORK = 1_048_576;

type HandoffValidationScanResult = { ok: true } | { ok: false; issues: string[] };

/**
 * Bound the complete object graph before field-level validation. The graph is
 * walked iteratively so hostile depth/cycles cannot exhaust the JS call stack.
 * Accessor properties are rejected without invoking user code.
 */
function scanHandoffGraph(value: unknown): HandoffValidationScanResult {
  if (!isRecord(value)) return { ok: true };
  const issues: string[] = [];
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: "$", depth: 0 }];
  let work = 0;
  let aggregateBytes = 0;
  const fail = (code: string, message: string): HandoffValidationScanResult => ({
    ok: false,
    issues: [`${code}: ${message}`],
  });
  while (stack.length > 0) {
    const current = stack.pop()!;
    work += 1;
    if (work > MAX_HANDOFF_VALIDATION_WORK) {
      return fail("SPEC_HANDOFF_WORK_LIMIT", `handoff validation work exceeds ${MAX_HANDOFF_VALIDATION_WORK} operations`);
    }
    if (current.depth > MAX_HANDOFF_VALIDATION_DEPTH) {
      return fail("SPEC_HANDOFF_DEPTH_LIMIT", `${current.path} exceeds the ${MAX_HANDOFF_VALIDATION_DEPTH}-level nesting limit`);
    }
    const currentValue = current.value;
    if (typeof currentValue === "string") {
      const bytes = Buffer.byteLength(currentValue, "utf8");
      aggregateBytes += bytes;
      if (bytes > MAX_HANDOFF_STRING_BYTES) {
        return fail("SPEC_HANDOFF_STRING_LIMIT", `${current.path} exceeds the ${MAX_HANDOFF_STRING_BYTES}-byte string limit`);
      }
      if (aggregateBytes > MAX_HANDOFF_AGGREGATE_BYTES) {
        return fail("SPEC_HANDOFF_AGGREGATE_LIMIT", `handoff string content exceeds the ${MAX_HANDOFF_AGGREGATE_BYTES}-byte aggregate limit`);
      }
      continue;
    }
    if (currentValue === null || typeof currentValue !== "object") continue;
    if (seen.has(currentValue)) continue;
    seen.add(currentValue);
    const prototype = Object.getPrototypeOf(currentValue);
    if (Array.isArray(currentValue)) {
      if (prototype !== Array.prototype && prototype !== null) {
        return fail("SPEC_HANDOFF_PROTOTYPE", `${current.path} must use the canonical array prototype`);
      }
      if (currentValue.length > MAX_HANDOFF_ARRAY_ITEMS) {
        return fail("SPEC_HANDOFF_COUNT_LIMIT", `${current.path} exceeds the ${MAX_HANDOFF_ARRAY_ITEMS}-item array limit`);
      }
      for (let index = currentValue.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(currentValue, String(index));
        if (!descriptor || !("value" in descriptor)) {
          return fail("SPEC_HANDOFF_ACCESSOR", `${current.path}[${index}] must be a data property`);
        }
        stack.push({ value: descriptor.value, path: `${current.path}[${index}]`, depth: current.depth + 1 });
      }
      continue;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      return fail("SPEC_HANDOFF_PROTOTYPE", `${current.path} must use the canonical object prototype`);
    }
    const keys = Object.getOwnPropertyNames(currentValue);
    if (keys.length > MAX_HANDOFF_ARRAY_ITEMS) {
      return fail("SPEC_HANDOFF_COUNT_LIMIT", `${current.path} exceeds the ${MAX_HANDOFF_ARRAY_ITEMS}-property object limit`);
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      const keyBytes = Buffer.byteLength(key, "utf8");
      aggregateBytes += keyBytes;
      if (keyBytes > MAX_HANDOFF_STRING_BYTES) {
        return fail("SPEC_HANDOFF_STRING_LIMIT", `${current.path} contains a key exceeding the ${MAX_HANDOFF_STRING_BYTES}-byte string limit`);
      }
      if (aggregateBytes > MAX_HANDOFF_AGGREGATE_BYTES) {
        return fail("SPEC_HANDOFF_AGGREGATE_LIMIT", `handoff content exceeds the ${MAX_HANDOFF_AGGREGATE_BYTES}-byte aggregate limit`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(currentValue, key);
      if (!descriptor || !("value" in descriptor)) {
        return fail("SPEC_HANDOFF_ACCESSOR", `${current.path}.${key} must be a data property`);
      }
      stack.push({ value: descriptor.value, path: `${current.path}.${key}`, depth: current.depth + 1 });
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}


function unknownKeys(value: UnknownRecord, allowed: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} unknown field`);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireString(value: UnknownRecord, key: string, path: string, issues: string[]): void {
  if (!nonEmptyString(value[key])) issues.push(`${path}.${key} must be a non-empty string`);
}

function requireStringOrNull(value: UnknownRecord, key: string, path: string, issues: string[]): void {
  if (value[key] !== null && !nonEmptyString(value[key])) issues.push(`${path}.${key} must be a non-empty string or null`);
}

function requireStringArray(value: UnknownRecord, key: string, path: string, issues: string[]): void {
  const entry = value[key];
  if (!Array.isArray(entry) || entry.some((item) => !nonEmptyString(item))) {
    issues.push(`${path}.${key} must be an array of non-empty strings`);
  }
}

function requirePositiveInt(value: UnknownRecord, key: string, path: string, issues: string[]): void {
  if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) {
    issues.push(`${path}.${key} must be a positive safe integer`);
  }
}

function requireDigest(value: UnknownRecord, key: string, path: string, issues: string[]): void {
  if (!isSha256Hex(value[key])) issues.push(`${path}.${key} must be a 64-char sha256 hex digest`);
}

function enumValue(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function requireEnum(value: UnknownRecord, key: string, path: string, issues: string[], allowed: readonly string[]): void {
  if (!enumValue(value[key], allowed)) issues.push(`${path}.${key} must be one of ${allowed.join(", ")}`);
}

function validateImportedContentProvenance(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  unknownKeys(value, ["source_kind", "content_role", "embedded_instruction_policy", "source_refs"], path, issues);
  if (value.source_kind !== "external") issues.push(`${path}.source_kind must equal external`);
  if (value.content_role !== "untrusted_inert_data") issues.push(`${path}.content_role must equal untrusted_inert_data`);
  if (value.embedded_instruction_policy !== "inert_data_only") issues.push(`${path}.embedded_instruction_policy must equal inert_data_only`);
  validateSafePathArray(value.source_refs, `${path}.source_refs`, issues);
}

/** Exact constitution binding; the version label is never trusted alone. */
export function validateConstitutionBinding(value: unknown, path = "$"): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return [`${path} must be an object`];
  unknownKeys(value, ["provider_id", "path", "version", "content_sha256", "semantic_hash", "validation_ref", "bound_at"], path, issues);
  requireString(value, "provider_id", path, issues);
  requireString(value, "version", path, issues);
  requireString(value, "validation_ref", path, issues);
  requireString(value, "bound_at", path, issues);
  for (const key of ["provider_id", "version", "validation_ref", "bound_at"] as const) {
    if (typeof value[key] === "string" && !isSafeCanonicalToken(value[key])) {
      issues.push(`${path}.${key} must be a bounded safe canonical token`);
    }
  }
  requireDigest(value, "content_sha256", path, issues);
  requireDigest(value, "semantic_hash", path, issues);
  if (!isSafeRelativePath(value.path)) {
    issues.push(`${path}.path must be a safe canonical project-relative path`);
  }
  return issues;
}

/**
 * Validate advisory recognizer output before it can enter a report, prompt,
 * or durable provenance. Recognizers are extension code, so their output is
 * treated as untrusted even though selected source paths came through the
 * core filesystem gate.
 */
export function validateFormatRecognitionResult(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  if (!isRecord(value)) return { ok: false, issues: ["$ must be an object"] };
  const issues: string[] = [];
  unknownKeys(value, ["framework", "confidence", "selected_paths", "ignored_candidates", "mapping_id", "mapping_version"], "$", issues);
  if (!isSafeCanonicalToken(value.framework)) issues.push("$.framework must be a bounded safe canonical token");
  if (!enumValue(value.confidence, ["high", "medium", "low", "ambiguous"])) issues.push("$.confidence must be a recognized confidence value");
  validateSafePathArray(value.selected_paths, "$.selected_paths", issues);
  if (!Array.isArray(value.ignored_candidates)) {
    issues.push("$.ignored_candidates must be an array");
  } else if (value.ignored_candidates.length > IMPORT_MAX_FILES) {
    issues.push(`$.ignored_candidates exceeds the ${IMPORT_MAX_FILES}-entry bound`);
  } else {
    const seen = new Set<string>();
    let aggregateBytes = 0;
    value.ignored_candidates.forEach((entry, index) => {
      const candidatePath = `$.ignored_candidates[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${candidatePath} must be an object`);
        return;
      }
      unknownKeys(entry, ["path", "reason"], candidatePath, issues);
      if (!isSafeRecognizerPath(entry.path)) {
        issues.push(`${candidatePath}.path must be a safe source-root-relative path`);
      } else {
        aggregateBytes += Buffer.byteLength(entry.path, "utf8");
        if (seen.has(entry.path)) issues.push("$.ignored_candidates must not contain duplicate paths");
        seen.add(entry.path);
      }
      if (!isSafeExternalMetadata(entry.reason, 512)) issues.push(`${candidatePath}.reason must be bounded line-inert metadata`);
      else aggregateBytes += Buffer.byteLength(entry.reason, "utf8");
    });
    if (aggregateBytes > IMPORT_MAX_PATH_AGGREGATE_BYTES) issues.push(`$.ignored_candidates exceeds the ${IMPORT_MAX_PATH_AGGREGATE_BYTES}-byte aggregate metadata bound`);
  }
  if (!isSafeCanonicalToken(value.mapping_id)) issues.push("$.mapping_id must be a bounded safe canonical token");
  if (!isSafeCanonicalToken(value.mapping_version)) issues.push("$.mapping_version must be a bounded safe canonical token");
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

const WORKSPACE_KEYS = [
  "schema_version", "feature_id", "display_name", "source_kind", "project_root", "project_root_identity", "path_binding",
  "workspace_path", "state_path", "profile_name", "profile_hash",
  "constitution_gate_ref", "constitution_binding", "language", "template_set",
  "phases", "status", "next_action", "handoff_ref", "execution_claim_prepare_ref", "execution_claim_ref",
  "implementation_conformance_ref", "import_ref", "migration_receipt_ref",
] as const;

const PHASE_STATUSES = [
  "not_started", "generating", "materialized", "validating",
  "awaiting_approval", "revision_required", "approved", "stale", "blocked",
] as const;
const WORKSPACE_STATUSES = [
  "created", "in_progress", "implementation_ready", "claimed", "executing",
  "completion_validating", "completion_blocked", "completed", "blocked", "stale",
] as const;
const WORKSPACE_PHASES = ["specify", "plan", "tasks"] as const;
const MAX_UPSTREAM_VERSIONS = 2;
const SOURCE_KINDS = ["native", "external", "legacy"] as const;
function validatePathIdentity(value: unknown, path: string, expectedRelative: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  unknownKeys(value, ["relative_path", "canonical_path", "dev", "ino"], path, issues);
  if (value.relative_path !== expectedRelative) issues.push(`${path}.relative_path must be exactly '${expectedRelative}'`);
  if (typeof value.canonical_path !== "string" || !value.canonical_path.startsWith("/") || !isSafeExternalMetadata(value.canonical_path, 4096)) {
    issues.push(`${path}.canonical_path must be a canonical absolute path`);
  }
  for (const key of ["dev", "ino"] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) issues.push(`${path}.${key} must be a bounded non-negative integer`);
  }
}

export function validateWorkspacePathBinding(value: unknown, featureId: string): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["$.path_binding must be an object"] };
  unknownKeys(value, ["specs", "feature_state", "artifacts", "execution_claim", "execution_claim_next"], "$.path_binding", issues);
  validatePathIdentity(value.specs, "$.path_binding.specs", `specs/${featureId}`, issues);
  validatePathIdentity(value.feature_state, "$.path_binding.feature_state", `.work-state/features/${featureId}`, issues);
  validatePathIdentity(value.artifacts, "$.path_binding.artifacts", `.work-state/features/${featureId}/artifacts`, issues);
  for (const [key, expectedRelative] of [
    ["execution_claim", `.work-state/features/${featureId}/artifacts/execution_claim`],
    ["execution_claim_next", `.work-state/features/${featureId}/artifacts/execution_claim/next`],
  ] as const) {
    if (value[key] !== null) validatePathIdentity(value[key], `$.path_binding.${key}`, expectedRelative, issues);
  }
  if ((value.execution_claim === null) !== (value.execution_claim_next === null)) {
    issues.push("$.path_binding claim storage identities must be both null or both initialized");
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

const NEXT_ACTION_KINDS = ["command", "checkpoint", "remediation", "none"] as const;

function validateWorkspacePhaseRecord(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  unknownKeys(
    value,
    ["phase", "status", "current_version", "approved_version", "validation_ref", "checkpoint_ref", "upstream_versions", "stale_reason", "last_feedback"],
    path,
    issues,
  );
  requireEnum(value, "phase", path, issues, WORKSPACE_PHASES);
  requireEnum(value, "status", path, issues, PHASE_STATUSES);
  for (const key of ["current_version", "approved_version"]) {
    if (value[key] !== null && (!Number.isInteger(value[key]) || (value[key] as number) < 1)) {
      issues.push(`${path}.${key} must be a positive integer or null`);
    }
  }
  requireStringOrNull(value, "validation_ref", path, issues);
  requireStringOrNull(value, "checkpoint_ref", path, issues);
  requireStringOrNull(value, "stale_reason", path, issues);
  requireStringOrNull(value, "last_feedback", path, issues);
  const hasCurrentVersion = Number.isInteger(value.current_version) && (value.current_version as number) >= 1;
  const hasApprovedVersion = Number.isInteger(value.approved_version) && (value.approved_version as number) >= 1;

  // A phase cannot carry validation or approval state without a current
  // immutable document version. Awaiting approval is reached only after the
  // current document passes validation; approved additionally binds that exact
  // current version to its checkpoint decision.
  if (value.current_version === null) {
    if (value.approved_version !== null) {
      issues.push(`${path}.approved_version must be null when current_version is null`);
    }
    if (value.validation_ref !== null) {
      issues.push(`${path}.validation_ref must be null when current_version is null`);
    }
    if (value.checkpoint_ref !== null) {
      issues.push(`${path}.checkpoint_ref must be null when current_version is null`);
    }
  }
  if (value.status === "not_started" && value.current_version !== null) {
    issues.push(`${path}.current_version must be null when status is not_started`);
  }
  if (value.status === "awaiting_approval" || value.status === "approved") {
    if (!hasCurrentVersion) {
      issues.push(`${path}.current_version is required when status is ${String(value.status)}`);
    }
    if (!nonEmptyString(value.validation_ref)) {
      issues.push(`${path}.validation_ref is required when status is ${String(value.status)}`);
    }
  }
  if (value.status === "approved") {
    if (!hasApprovedVersion) {
      issues.push(`${path}.approved_version is required when status is approved`);
    } else if (hasCurrentVersion && value.approved_version !== value.current_version) {
      issues.push(`${path}.approved_version must equal current_version when status is approved`);
    }
    if (!nonEmptyString(value.checkpoint_ref)) {
      issues.push(`${path}.checkpoint_ref is required when status is approved`);
    }
  }
  if (hasApprovedVersion) {
    if (!nonEmptyString(value.validation_ref)) {
      issues.push(`${path}.validation_ref is required when approved_version is set`);
    }
    if (!nonEmptyString(value.checkpoint_ref)) {
      issues.push(`${path}.checkpoint_ref is required when approved_version is set`);
    }
    if (hasCurrentVersion && (value.approved_version as number) > (value.current_version as number)) {
      issues.push(`${path}.approved_version must not exceed current_version`);
    }
  }
  if (value.status === "stale" && !nonEmptyString(value.stale_reason)) {
    issues.push(`${path}.stale_reason is required when status is stale`);
  }
  if (!Array.isArray(value.upstream_versions)) {
    issues.push(`${path}.upstream_versions must be an array`);
    return;
  }
  if (value.upstream_versions.length > MAX_UPSTREAM_VERSIONS) {
    issues.push(`${path}.upstream_versions exceeds the ${MAX_UPSTREAM_VERSIONS}-entry contract bound`);
    return;
  }
  const expectedUpstream = value.phase === "specify"
    ? []
    : value.phase === "plan"
      ? ["specify"]
      : value.phase === "tasks"
        ? ["specify", "plan"]
        : null;
  const requiredUpstream = expectedUpstream === null
    ? null
    : value.phase === "specify"
      || Number.isSafeInteger(value.current_version)
      || (value.status !== "not_started" && value.status !== "generating")
      ? expectedUpstream
      : [];
  if (requiredUpstream !== null) {
    if (value.upstream_versions.length !== requiredUpstream.length) {
      issues.push(`${path}.upstream_versions must contain exactly ${requiredUpstream.length} entries for phase ${String(value.phase)} at its current version`);
    }
    const seen = new Set<unknown>();
    value.upstream_versions.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      if (seen.has(entry.phase)) issues.push(`${path}.upstream_versions[${index}].phase must be unique`);
      seen.add(entry.phase);
      if (entry.phase !== requiredUpstream[index]) {
        issues.push(`${path}.upstream_versions[${index}].phase must be '${requiredUpstream[index] ?? "none"}' at position ${index}`);
      }
    });
  }
  value.upstream_versions.forEach((entry, index) => {
    const upstreamPath = `${path}.upstream_versions[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${upstreamPath} must be an object`);
      return;
    }
    unknownKeys(entry, ["phase", "version", "hash"], upstreamPath, issues);
    requireEnum(entry, "phase", upstreamPath, issues, WORKSPACE_PHASES);
    requirePositiveInt(entry, "version", upstreamPath, issues);
    requireDigest(entry, "hash", upstreamPath, issues);
  });
}

const NEXT_ACTION_REASON_MAX_LENGTH = 512;
const NEXT_ACTION_COMMAND_MAX_LENGTH = 512;
const IMPORT_MAX_FILES = 512;
const IMPORT_MAX_REDACTIONS = 4096;
const IMPORT_MAX_MAPPINGS = 16_384;
const IMPORT_MAX_FINDINGS = 8_192;
const IMPORT_MAX_FINDING_EVIDENCE = 128;
const BARE_NEXT_ACTION_COMMANDS = new Set(["/specify", "/spec-plan", "/spec-tasks", "/do-work"]);

function canonicalNextActionCommand(value: unknown, featureId: string | null): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > NEXT_ACTION_COMMAND_MAX_LENGTH) return false;
  if (value === "ensure_project_constitution") return true;
  if (BARE_NEXT_ACTION_COMMANDS.has(value)) return true;
  const phase = /^\/(specify|spec-plan|spec-tasks) --feature ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(value);
  if (phase) return isSafeFeatureId(phase[2]) && (featureId === null || phase[2] === featureId);
  const execution = /^\/do-work --spec ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u.exec(value);
  return Boolean(execution && isSafeFeatureId(execution[1]) && (featureId === null || execution[1] === featureId));
}

function validateNextAction(value: unknown, actionPath: string, issues: string[], featureId: string | null = null): void {
  if (!isRecord(value)) {
    issues.push(`${actionPath} must be an object`);
    return;
  }
  unknownKeys(value, ["kind", "command", "reason"], actionPath, issues);
  requireEnum(value, "kind", actionPath, issues, NEXT_ACTION_KINDS);
  if (!isSafeExternalMetadata(value.reason, NEXT_ACTION_REASON_MAX_LENGTH)) {
    issues.push(`${actionPath}.reason must be a bounded single-line reason without control, format, or line-separator characters`);
  }
  if (value.command !== null && (!isSafeExternalMetadata(value.command, NEXT_ACTION_COMMAND_MAX_LENGTH) || !canonicalNextActionCommand(value.command, featureId))) {
    issues.push(`${actionPath}.command must be a known canonical command with a matching feature selector`);
  }
  if (value.kind === "command" && (typeof value.command !== "string" || value.command.length === 0)) {
    issues.push(`${actionPath}.command is required when kind is command`);
  }
  if ((value.kind === "checkpoint" || value.kind === "none") && value.command !== null) {
    issues.push(`${actionPath}.command must be null when kind is ${String(value.kind)}`);
  }
  const canonicalPhaseRemediation = /^(?:\/specify|\/spec-plan|\/spec-tasks)(?: --feature [A-Za-z0-9][A-Za-z0-9._-]*)?$/u;
  if (value.kind === "remediation" && typeof value.command === "string"
    && value.command !== "ensure_project_constitution"
    && !canonicalPhaseRemediation.test(value.command)) {
    issues.push(`${actionPath}.command must be null, ensure_project_constitution, or a canonical /specify, /spec-plan, or /spec-tasks remediation with an optional --feature selector`);
  }
}

/**
 * Fail-closed strict validation of the canonical FeatureWorkspace record.
 * Identity/path bindings, enums, approval invariants, and the embedded
 * constitution binding are all checked; any issue means the record is invalid.
 */
export function validateFeatureWorkspaceRecord(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  if (!isRecord(value)) return { ok: false, issues: ["$ must be an object"] };
  const issues: string[] = [];
  unknownKeys(value, WORKSPACE_KEYS, "$", issues);
  const featureId = typeof value.feature_id === "string" ? value.feature_id : null;
  if (value.schema_version !== 2 && value.schema_version !== 3) issues.push("$.schema_version must be 2 or 3");
  if (!isSafeFeatureId(value.feature_id)) issues.push("$.feature_id must be a safe feature id (^[a-z0-9][a-z0-9._-]*$)");
  if (value.schema_version === 3) {
    const binding = validateWorkspacePathBinding(value.path_binding, featureId ?? "");
    if (!binding.ok) issues.push(...binding.issues);
    requireStringOrNull(value, "execution_claim_prepare_ref", "$", issues);
  } else if (value.path_binding !== undefined || value.execution_claim_prepare_ref !== undefined) {
    issues.push("$.path_binding and $.execution_claim_prepare_ref are only valid in schema 3");
  }
  requireString(value, "display_name", "$", issues);
  requireEnum(value, "source_kind", "$", issues, SOURCE_KINDS);
  if (typeof value.project_root !== "string" || !value.project_root.startsWith("/")) issues.push("$.project_root must be an absolute project root path");
  if (!isRecord(value.project_root_identity)) {
    issues.push("$.project_root_identity must be an object");
  } else {
    unknownKeys(value.project_root_identity, ["canonical_path", "dev", "ino"], "$.project_root_identity", issues);
    if (!isSafeExternalMetadata(value.project_root_identity.canonical_path, 4096) || typeof value.project_root_identity.canonical_path !== "string" || !value.project_root_identity.canonical_path.startsWith("/")) issues.push("$.project_root_identity.canonical_path must be a canonical absolute line-inert path");
    for (const key of ["dev", "ino"] as const) if (!Number.isSafeInteger(value.project_root_identity[key]) || (value.project_root_identity[key] as number) < 0) issues.push(`$.project_root_identity.${key} must be a bounded non-negative integer`);
  }
  if (featureId) {
    if (value.workspace_path !== `specs/${featureId}`) issues.push(`$.workspace_path must be exactly 'specs/${featureId}' to match the immutable identity`);
    if (value.state_path !== `.work-state/features/${featureId}/state.json`) issues.push(`$.state_path must be exactly '.work-state/features/${featureId}/state.json' to match the immutable identity`);
  } else {
    if (typeof value.workspace_path !== "string") issues.push("$.workspace_path must be a string");
    if (typeof value.state_path !== "string") issues.push("$.state_path must be a string");
  }
  requireString(value, "profile_name", "$", issues);
  requireString(value, "profile_hash", "$", issues);
  requireStringOrNull(value, "constitution_gate_ref", "$", issues);
  requireStringOrNull(value, "handoff_ref", "$", issues);
  requireStringOrNull(value, "execution_claim_ref", "$", issues);
  requireStringOrNull(value, "implementation_conformance_ref", "$", issues);
  requireStringOrNull(value, "import_ref", "$", issues);
  requireStringOrNull(value, "migration_receipt_ref", "$", issues);
  if (value.constitution_binding !== null && value.constitution_binding !== undefined) issues.push(...validateConstitutionBinding(value.constitution_binding, "$.constitution_binding"));
  if (!isRecord(value.language)) issues.push("$.language must be an object");
  else {
    unknownKeys(value.language, ["language", "source", "selection_hash"], "$.language", issues);
    requireString(value.language, "language", "$.language", issues);
    requireEnum(value.language, "source", "$.language", issues, ["feature_override", "project_default", "request_language"]);
    requireDigest(value.language, "selection_hash", "$.language", issues);
  }
  if (!isRecord(value.template_set)) issues.push("$.template_set must be an object");
  else {
    unknownKeys(value.template_set, ["template_set_id", "source", "content_hash", "required_markers"], "$.template_set", issues);
    requireString(value.template_set, "template_set_id", "$.template_set", issues);
    requireEnum(value.template_set, "source", "$.template_set", issues, ["feature_override", "project_default", "shipped_default"]);
    requireDigest(value.template_set, "content_hash", "$.template_set", issues);
    requireStringArray(value.template_set, "required_markers", "$.template_set", issues);
  }
  if (!Array.isArray(value.phases) || value.phases.length === 0) issues.push("$.phases must be a non-empty array");
  else {
    const phases = value.phases.map((entry) => (isRecord(entry) ? entry.phase : null));
    if (new Set(phases).size !== phases.length) issues.push("$.phases must contain each phase at most once");
    if (value.source_kind === "native") {
      const expected = [...WORKSPACE_PHASES];
      if (phases.length !== expected.length || !phases.every((phase, index) => phase === expected[index])) issues.push("$.phases must be exactly [specify, plan, tasks] for native workspaces");
    }
    value.phases.forEach((entry, index) => validateWorkspacePhaseRecord(entry, `$.phases[${index}]`, issues));
  }
  requireEnum(value, "status", "$", issues, WORKSPACE_STATUSES);
  validateNextAction(value.next_action, "$.next_action", issues, isSafeFeatureId(value.feature_id) ? value.feature_id : null);
  if (value.source_kind === "external" && value.import_ref === null) issues.push("$.import_ref is required when source_kind is external");
  if (value.source_kind === "legacy") {
    if (value.migration_receipt_ref === null) issues.push("$.migration_receipt_ref is required when source_kind is legacy");
    else if (typeof value.migration_receipt_ref !== "string" || !MIGRATION_RECEIPT_ID_RE.test(value.migration_receipt_ref)) issues.push("$.migration_receipt_ref must be the canonical migration receipt artifact id");
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * One-way schema-1 boundary for persisted feature workspaces. The caller must
 * supply identity captured from the current pinned project-root descriptor;
 * this function never derives authority from a caller path or persisted hash.
 * Any approval, handoff, claim, or implementation-ready state from the
 * identity-less schema is cleared and made stale before v2 validation.
 */
export function normalizeFeatureWorkspaceV1(value: unknown, identity: ProjectRootIdentity): FeatureWorkspace | null {
  if (!isRecord(value) || value.schema_version !== 1) return null;
  if (!isSafeExternalMetadata(identity.canonical_path, 4096) || !identity.canonical_path.startsWith("/")
    || !Number.isSafeInteger(identity.dev) || identity.dev < 0
    || !Number.isSafeInteger(identity.ino) || identity.ino < 0) return null;
  const phases = Array.isArray(value.phases) ? value.phases : [];
  const priorAuthority = new Set(["implementation_ready", "claimed", "executing", "completion_validating", "completion_blocked", "completed"]).has(String(value.status))
    || isSafeExternalMetadata(value.handoff_ref)
    || isSafeExternalMetadata(value.execution_claim_ref)
    || isSafeExternalMetadata(value.implementation_conformance_ref)
    || phases.some((entry) => isRecord(entry)
      && (entry.status === "approved"
        || entry.approved_version !== null && entry.approved_version !== undefined
        || entry.validation_ref !== null && entry.validation_ref !== undefined
        || entry.checkpoint_ref !== null && entry.checkpoint_ref !== undefined));
  const migratedPhases = phases.map((entry) => {
    if (!isRecord(entry)) return entry;
    const phaseAuthority = entry.status === "approved"
      || entry.approved_version !== null && entry.approved_version !== undefined
      || entry.validation_ref !== null && entry.validation_ref !== undefined
      || entry.checkpoint_ref !== null && entry.checkpoint_ref !== undefined;
    if (!priorAuthority || !phaseAuthority) return { ...entry };
    return {
      ...entry,
      status: "stale",
      approved_version: null,
      validation_ref: null,
      checkpoint_ref: null,
      stale_reason: "pre-identity approval evidence requires revalidation and human approval after project-root binding",
    };
  });
  if (priorAuthority && !migratedPhases.some((entry) => isRecord(entry) && entry.status === "stale")) {
    const index = migratedPhases.findIndex((entry) => isRecord(entry));
    if (index >= 0) {
      const entry = migratedPhases[index] as Record<string, unknown>;
      migratedPhases[index] = {
        ...entry,
        status: "stale",
        approved_version: null,
        validation_ref: null,
        checkpoint_ref: null,
        stale_reason: "pre-identity approval evidence requires revalidation and human approval after project-root binding",
      };
    }
  }
  const migrated: Record<string, unknown> = {
    ...value,
    schema_version: 2,
    project_root_identity: { ...identity },
    phases: migratedPhases,
  };
  if (priorAuthority) {
    migrated.status = "stale";
    migrated.handoff_ref = null;
    migrated.execution_claim_ref = null;
    migrated.implementation_conformance_ref = null;

    const typedPhases = migratedPhases.filter(isRecord) as unknown as WorkspacePhaseRecord[];
    migrated.next_action = nextActionForWorkspace(typedPhases, {
      status: "stale",
      hasConstitutionBinding: isRecord(migrated.constitution_binding),
      sourceKind: migrated.source_kind as FeatureWorkspace["source_kind"],
    });
  }
  const valid = validateFeatureWorkspaceRecord(migrated);
  return valid.ok ? migrated as unknown as FeatureWorkspace : null;
}

/** One-way schema-2 to schema-3 normalizer; callers supply pinned identities. */
export function normalizeFeatureWorkspaceV2(value: unknown, binding: WorkspacePathBinding): FeatureWorkspace | null {
  if (!isRecord(value) || value.schema_version !== 2) return null;
  const migrated: Record<string, unknown> = {
    ...value,
    schema_version: 3,
    path_binding: binding,
    execution_claim_prepare_ref: null,
  };
  const valid = validateFeatureWorkspaceRecord(migrated);
  return valid.ok ? migrated as unknown as FeatureWorkspace : null;
}


/**
 * Strict validation of the frozen implementation handoff, including the
 * complete requirement → acceptance → decision → task → verification
 * traceability and the acyclic task graph.
 */
export function validateImplementationHandoff(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  try {
    const scan = scanHandoffGraph(value);
    if (!scan.ok) return scan;
    return validateImplementationHandoffUnchecked(value);
  } catch {
    return { ok: false, issues: ["SPEC_HANDOFF_VALIDATION_FAILED: handoff validation failed closed"] };
  }
}

function validateImplementationHandoffUnchecked(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  if (!isRecord(value)) return { ok: false, issues: ["$ must be an object"] };
  const issues: string[] = [];
  unknownKeys(
    value,
    ["schema_version", "handoff_id", "handoff_digest", "feature_id", "source_kind", "content_provenance", "artifact_versions", "scope", "requirements", "decisions", "tasks", "verification", "validation_refs", "approval_refs", "language", "constitution_binding", "constitution_impact_ref", "risks", "open_decisions", "execution_choices", "status", "import_snapshot_ref", "compatibility_supplement_ref", "import_framework", "import_mapping_id", "import_mapping_version", "import_selected_paths", "import_ignored_candidates", "import_intake_paths", "import_document_language", "import_document_language_source", "import_source_revision", "import_limits"],
    "$",
    issues,
  );
  if (value.schema_version !== 1) issues.push("$.schema_version must be 1");
  requireString(value, "handoff_id", "$", issues);
  requireDigest(value, "handoff_digest", "$", issues);
  requireString(value, "feature_id", "$", issues);
  requireEnum(value, "source_kind", "$", issues, SOURCE_KINDS);
  requireEnum(value, "status", "$", issues, ["candidate", "ready", "stale"]);
  if (value.source_kind === "external") {
    validateImportedContentProvenance(value.content_provenance, "$.content_provenance", issues);
    requireString(value, "import_framework", "$", issues);
    requireString(value, "import_mapping_id", "$", issues);
    requireString(value, "import_mapping_version", "$", issues);
    if (value.import_framework !== undefined && !isSafeCanonicalToken(value.import_framework)) issues.push("$.import_framework must be a safe canonical token");
    if (value.import_mapping_id !== undefined && !isSafeCanonicalToken(value.import_mapping_id)) issues.push("$.import_mapping_id must be a safe canonical token");
    if (value.import_mapping_version !== undefined && !isSafeCanonicalToken(value.import_mapping_version)) issues.push("$.import_mapping_version must be a safe canonical token");
    if (!Array.isArray(value.import_selected_paths)) {
      issues.push("$.import_selected_paths must be an array of safe relative paths");
    } else if (value.import_selected_paths.some((path: unknown) => !isSafeRelativePath(path))) {
      issues.push("$.import_selected_paths must contain safe relative paths");
    }
    if (!Array.isArray(value.import_ignored_candidates)) {
      issues.push("$.import_ignored_candidates must contain safe path/reason entries");
    } else if (value.import_ignored_candidates.some((entry: unknown) =>
      !isRecord(entry) || !isSafeRelativePath(entry.path) || !isSafeExternalMetadata(entry.reason, 512))) {
      issues.push("$.import_ignored_candidates must contain safe path/reason entries");
    }
    if (!Array.isArray(value.import_intake_paths)) {
      issues.push("$.import_intake_paths must be an array of safe relative paths");
    } else if (value.import_intake_paths.length === 0 || value.import_intake_paths.some((path: unknown) => path !== "." && !isSafeRelativePath(path))) {
      issues.push("$.import_intake_paths must contain safe relative paths");
    }
    requireString(value, "import_document_language", "$", issues);
    if (typeof value.import_document_language !== "string" || value.import_document_language.length > 64 || !CANONICAL_LANGUAGE_RE.test(value.import_document_language)) issues.push("$.import_document_language must be a canonical BCP-47 language tag");
    requireString(value, "import_document_language_source", "$", issues);
    if (!["explicit", "metadata", "unknown"].includes(value.import_document_language_source as string)) issues.push("$.import_document_language_source must be explicit, metadata, or unknown");
    requireStringOrNull(value, "import_source_revision", "$", issues);
    if (value.import_source_revision !== null && (typeof value.import_source_revision !== "string" || !isSafeExternalMetadata(value.import_source_revision, 256))) issues.push("$.import_source_revision must be null or bounded line-inert metadata");
  } else if (value.content_provenance !== undefined) {
    validateImportedContentProvenance(value.content_provenance, "$.content_provenance", issues);
  }
  if (value.import_limits !== undefined) {
    const limitsValidation = validateImportLimits(value.import_limits, "$.import_limits");
    if (!limitsValidation.ok) issues.push(...limitsValidation.issues);
  }
  if (value.source_kind !== "external" && value.import_framework !== undefined && !isSafeCanonicalToken(value.import_framework)) issues.push("$.import_framework must be a safe canonical token");
  if (value.source_kind !== "external" && value.import_mapping_id !== undefined && !isSafeCanonicalToken(value.import_mapping_id)) issues.push("$.import_mapping_id must be a safe canonical token");
  if (value.source_kind !== "external" && value.import_mapping_version !== undefined && !isSafeCanonicalToken(value.import_mapping_version)) issues.push("$.import_mapping_version must be a safe canonical token");
  if (value.source_kind !== "external" && value.import_selected_paths !== undefined) {
    if (!Array.isArray(value.import_selected_paths) || value.import_selected_paths.some((path: unknown) => !isSafeRelativePath(path))) issues.push("$.import_selected_paths must be safe relative paths");
  }
  if (value.source_kind !== "external" && value.import_ignored_candidates !== undefined && (!Array.isArray(value.import_ignored_candidates) || value.import_ignored_candidates.some((entry: unknown) => !isRecord(entry) || !isSafeRelativePath(entry.path) || !isSafeExternalMetadata(entry.reason, 512)))) {
    issues.push("$.import_ignored_candidates must contain safe path/reason entries");
  }
  if (value.status === "ready" && value.open_decisions !== undefined && Array.isArray(value.open_decisions) && value.open_decisions.length > 0) {
    issues.push("$.open_decisions must be empty when status is ready");
  }
  if (value.status === "ready" && Array.isArray(value.approval_refs) && value.approval_refs.length === 0) {
    issues.push("$.approval_refs must be non-empty when status is ready");
  }
  if (!isRecord(value.scope)) {
    issues.push("$.scope must be an object");
  } else {
    unknownKeys(value.scope, ["in_scope", "out_of_scope", "constraints"], "$.scope", issues);
    requireStringArray(value.scope, "in_scope", "$.scope", issues);
    requireStringArray(value.scope, "out_of_scope", "$.scope", issues);
    requireStringArray(value.scope, "constraints", "$.scope", issues);
  }
  issues.push(...validateConstitutionBinding(value.constitution_binding, "$.constitution_binding"));
  requireStringOrNull(value, "constitution_impact_ref", "$", issues);

  if (!Array.isArray(value.artifact_versions)) {
    issues.push("$.artifact_versions must be an array");
  } else {
    const artifactIds = new Set<string>();
    value.artifact_versions.forEach((entry, index) => {
      const artifactPath = `$.artifact_versions[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${artifactPath} must be an object`);
        return;
      }
      unknownKeys(entry, ["artifact_id", "kind", "version", "sha256"], artifactPath, issues);
      requireString(entry, "artifact_id", artifactPath, issues);
      if (nonEmptyString(entry.artifact_id)) {
        if (artifactIds.has(entry.artifact_id)) issues.push(`${artifactPath}.artifact_id duplicates an existing version binding`);
        artifactIds.add(entry.artifact_id);
      }
      requireEnum(entry, "kind", artifactPath, issues, ["specify", "plan", "tasks", "import_snapshot", "supplement"]);
      requirePositiveInt(entry, "version", artifactPath, issues);
      requireDigest(entry, "sha256", artifactPath, issues);
    });
  }
  const requirementIds = new Set<string>();
  const acceptanceIds = new Set<string>();
  const acceptanceOwners = new Map<string, string>();
  if (!Array.isArray(value.requirements) || value.requirements.length === 0) {
    issues.push("$.requirements must be a non-empty array");
  } else {
    value.requirements.forEach((entry, index) => {
      const requirementPath = `$.requirements[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${requirementPath} must be an object`);
        return;
      }
      unknownKeys(entry, ["requirement_id", "statement", "acceptance_ids", "source_refs"], requirementPath, issues);
      requireString(entry, "requirement_id", requirementPath, issues);
      if (nonEmptyString(entry.requirement_id)) {
        if (requirementIds.has(entry.requirement_id)) issues.push(`${requirementPath}.requirement_id duplicates an existing requirement`);
        requirementIds.add(entry.requirement_id);
        for (const acceptance of Array.isArray(entry.acceptance_ids) ? entry.acceptance_ids : []) {
          if (nonEmptyString(acceptance)) {
            if (acceptanceOwners.has(acceptance)) {
              issues.push(`${requirementPath}.acceptance_ids contains duplicate acceptance id '${acceptance}' owned by '${acceptanceOwners.get(acceptance)}'`);
            } else {
              acceptanceOwners.set(acceptance, entry.requirement_id);
            }
            acceptanceIds.add(acceptance);
          }
        }
      }
      requireString(entry, "statement", requirementPath, issues);
      if (!Array.isArray(entry.acceptance_ids) || entry.acceptance_ids.length === 0
        || entry.acceptance_ids.some((id: unknown) => !nonEmptyString(id))) {
        issues.push(`${requirementPath}.acceptance_ids must be a non-empty array of non-empty strings`);
      }
      requireStringArray(entry, "source_refs", requirementPath, issues);
    });
  }

  if (!Array.isArray(value.decisions)) {
    issues.push("$.decisions must be an array");
  } else {
    value.decisions.forEach((entry, index) => {
      const decisionPath = `$.decisions[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${decisionPath} must be an object`);
        return;
      }
      unknownKeys(entry, ["decision_id", "decision", "rationale", "requirement_ids"], decisionPath, issues);
      requireString(entry, "decision_id", decisionPath, issues);
      requireString(entry, "decision", decisionPath, issues);
      requireString(entry, "rationale", decisionPath, issues);
      if (!Array.isArray(entry.requirement_ids) || entry.requirement_ids.length === 0
        || entry.requirement_ids.some((id: unknown) => !requirementIds.has(id as string))) {
        issues.push(`${decisionPath}.requirement_ids must link existing requirement ids`);
      }
    });
  }

  const taskIds = new Set<string>();
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    issues.push("$.tasks must be a non-empty array");
  } else {
    value.tasks.forEach((entry, index) => {
      const taskPath = `$.tasks[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${taskPath} must be an object`);
        return;
      }
      unknownKeys(entry, ["task_id", "title", "requirement_ids", "depends_on", "expected_outcome", "affected_scope", "completion_evidence", "parallel_safe"], taskPath, issues);
      requireString(entry, "task_id", taskPath, issues);
      if (nonEmptyString(entry.task_id)) {
        if (taskIds.has(entry.task_id)) issues.push(`${taskPath}.task_id duplicates an existing task`);
        taskIds.add(entry.task_id);
      }
      requireString(entry, "title", taskPath, issues);
      requireString(entry, "expected_outcome", taskPath, issues);
      if (typeof entry.parallel_safe !== "boolean") issues.push(`${taskPath}.parallel_safe must be a boolean`);
      if (!Array.isArray(entry.requirement_ids) || entry.requirement_ids.length === 0
        || entry.requirement_ids.some((id: unknown) => !requirementIds.has(id as string))) {
        issues.push(`${taskPath}.requirement_ids must link existing requirement ids`);
      }
      if (!Array.isArray(entry.depends_on)) issues.push(`${taskPath}.depends_on must be an array`);
      if (!Array.isArray(entry.affected_scope) || entry.affected_scope.length === 0
        || entry.affected_scope.some((id: unknown) => !nonEmptyString(id))) {
        issues.push(`${taskPath}.affected_scope must be a non-empty array of non-empty strings`);
      }
      if (!Array.isArray(entry.completion_evidence) || entry.completion_evidence.length === 0
        || entry.completion_evidence.some((id: unknown) => !nonEmptyString(id))) {
        issues.push(`${taskPath}.completion_evidence must be a non-empty array of non-empty strings`);
      }
    });
    // Dependencies must reference declared tasks (dangling check needs the full id set).
    value.tasks.forEach((entry, index) => {
      if (!isRecord(entry) || !Array.isArray(entry.depends_on)) return;
      entry.depends_on.forEach((dependency, depIndex) => {
        if (dependency === entry.task_id) issues.push(`SPEC_TASK_SELF_DEPENDENCY: $.tasks[${index}].depends_on[${depIndex}] must not self-reference`);
        else if (!taskIds.has(dependency as string)) issues.push(`SPEC_TASK_DANGLING_DEPENDENCY: $.tasks[${index}].depends_on[${depIndex}] references an unknown task`);
      });
    });
    // Cycle detection (iterative DFS, three colors).
    const adjacency = new Map<string, string[]>();
    for (const entry of value.tasks) {
      if (!isRecord(entry) || !nonEmptyString(entry.task_id)) continue;
      adjacency.set(entry.task_id, Array.isArray(entry.depends_on) ? entry.depends_on.filter((id): id is string => nonEmptyString(id)) : []);
    }
    const UNSEEN = 0, ACTIVE = 1, DONE = 2;
    const color = new Map<string, number>();
    let cycleDetected = false;
    for (const rootTaskId of adjacency.keys()) {
      if ((color.get(rootTaskId) ?? UNSEEN) !== UNSEEN) continue;
      color.set(rootTaskId, ACTIVE);
      const stack: Array<{ taskId: string; nextDependency: number }> = [{ taskId: rootTaskId, nextDependency: 0 }];
      while (stack.length > 0 && !cycleDetected) {
        const frame = stack[stack.length - 1]!;
        const dependencies = adjacency.get(frame.taskId) ?? [];
        if (frame.nextDependency >= dependencies.length) {
          color.set(frame.taskId, DONE);
          stack.pop();
          continue;
        }
        const dependency = dependencies[frame.nextDependency]!;
        frame.nextDependency += 1;
        const state = color.get(dependency) ?? UNSEEN;
        if (state === ACTIVE) {
          cycleDetected = true;
          break;
        }
        if (state === UNSEEN) {
          color.set(dependency, ACTIVE);
          stack.push({ taskId: dependency, nextDependency: 0 });
        }
      }
      if (cycleDetected) break;
    }
    if (cycleDetected) issues.push("SPEC_TASK_DEPENDENCY_CYCLE: $.tasks must be an acyclic dependency graph");
  }
  if (!Array.isArray(value.verification) || value.verification.length === 0) {
    issues.push("$.verification must be a non-empty array");
  } else {
    value.verification.forEach((entry, index) => {
      const verificationPath = `$.verification[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${verificationPath} must be an object`);
        return;
      }
      unknownKeys(entry, ["verification_id", "requirement_ids", "acceptance_ids", "task_ids", "observable_behavior", "expected_evidence"], verificationPath, issues);
      requireString(entry, "verification_id", verificationPath, issues);
      requireString(entry, "expected_evidence", verificationPath, issues);
      if (typeof entry.observable_behavior !== "boolean") issues.push(`${verificationPath}.observable_behavior must be a boolean`);
      if (!Array.isArray(entry.requirement_ids) || entry.requirement_ids.length === 0
        || entry.requirement_ids.some((id: unknown) => !requirementIds.has(id as string))) {
        issues.push(`${verificationPath}.requirement_ids must link existing requirement ids`);
      }
      if (!Array.isArray(entry.acceptance_ids) || entry.acceptance_ids.length === 0
        || entry.acceptance_ids.some((id: unknown) => !acceptanceIds.has(id as string))) {
        issues.push(`${verificationPath}.acceptance_ids must link declared acceptance scenario ids`);
      }
      if (!Array.isArray(entry.task_ids) || entry.task_ids.length === 0
        || entry.task_ids.some((id: unknown) => !taskIds.has(id as string))) {
        issues.push(`${verificationPath}.task_ids must link existing task ids`);
      }
    });
  }
  if (issues.length === 0) {
    const traceabilityFindings = checkTraceability(value as unknown as ImplementationHandoff);
    for (const traceabilityFinding of traceabilityFindings) {
      issues.push(`$.traceability ${traceabilityFinding.code}: ${traceabilityFinding.message}`);
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function validateClaimAdmissionBinding(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  unknownKeys(value, [
    "mapping_record_path", "mapping_record_digest", "mapping_id", "mapping_hash", "mapping_version",
    "confirmation_state_revision", "feature_state_revision", "confirmation_state_digest", "confirmation_ledger_digest",
    "confirmation_authorization_digest",
    "checkpoint_ref", "trusted_answer_ref", "stage_id", "policy_hash", "wave_id", "capability_id", "capability_epoch",
  ], path, issues);
  if (!isSafeRelativePath(value.mapping_record_path)) issues.push(`${path}.mapping_record_path must be a safe relative path`);
  requireDigest(value, "mapping_record_digest", path, issues);
  if (!isSafeFeatureId(value.mapping_id)) issues.push(`${path}.mapping_id must be a safe feature id`);
  requireDigest(value, "mapping_hash", path, issues);
  if (!Number.isSafeInteger(value.mapping_version) || (value.mapping_version as number) < 1) issues.push(`${path}.mapping_version must be an integer >= 1`);
  if (!Number.isSafeInteger(value.confirmation_state_revision) || (value.confirmation_state_revision as number) < 0) issues.push(`${path}.confirmation_state_revision must be an integer >= 0`);
  if (!Number.isSafeInteger(value.feature_state_revision) || (value.feature_state_revision as number) < 0) issues.push(`${path}.feature_state_revision must be an integer >= 0`);
  requireDigest(value, "confirmation_state_digest", path, issues);
  requireDigest(value, "confirmation_authorization_digest", path, issues);
  requireDigest(value, "confirmation_ledger_digest", path, issues);
  for (const key of ["checkpoint_ref", "trusted_answer_ref", "stage_id", "policy_hash", "wave_id", "capability_id", "capability_epoch"]) requireString(value, key, path, issues);
}

/** Strict validation of an exclusive execution claim. */
export function validateExecutionClaim(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  if (!isRecord(value)) return { ok: false, issues: ["$ must be an object"] };
  const issues: string[] = [];
  unknownKeys(value, ["claim_id", "handoff_digest", "owner_kind", "owner_run_id", "status", "acquired_at", "updated_at", "release_reason", "admission_binding"], "$", issues);
  requireString(value, "claim_id", "$", issues);
  requireDigest(value, "handoff_digest", "$", issues);
  requireEnum(value, "owner_kind", "$", issues, ["do_work", "cto"]);
  requireString(value, "owner_run_id", "$", issues);
  requireEnum(value, "status", "$", issues, ["active", "completed", "released", "blocked"]);
  requireString(value, "acquired_at", "$", issues);
  requireString(value, "updated_at", "$", issues);
  if ((value.status === "released" || value.status === "blocked") && !nonEmptyString(value.release_reason)) {
    issues.push("$.release_reason is required when status is released or blocked");
  }
  if ((value.status === "active" || value.status === "completed") && value.release_reason !== null && value.release_reason !== undefined) {
    issues.push("$.release_reason must be null when status is active or completed");
  }
  if (value.owner_kind === "cto" && (value.status === "active" || value.status === "completed") && value.admission_binding === undefined) {
    issues.push("$.admission_binding is required for active or completed CTO claims; legacy unbound claims must be blocked or invalidated");
  }
  if (value.admission_binding !== undefined) validateClaimAdmissionBinding(value.admission_binding, "$.admission_binding", issues);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

const CONFORMANCE_NEXT_ACTIONS = [
  "complete_feature", "repair_implementation", "repeat_review",
  "repeat_tests", "repair_quality_gate", "revise_specification",
] as const;
export const MAX_CONFORMANCE_ARTIFACT_BYTES = 1 * 1024 * 1024;
export const MAX_CONFORMANCE_ENTRIES = 256;
export const MAX_CONFORMANCE_QUALITY_GATES = 64;
export const MAX_CONFORMANCE_EVIDENCE_REFS = 64;
export const MAX_CONFORMANCE_TEST_EVIDENCE = 64;
export const MAX_CONFORMANCE_FINDINGS = 128;
export const MAX_CONFORMANCE_FINDING_REFS = 64;
export const MAX_CONFORMANCE_AGGREGATE_BYTES = 2 * 1024 * 1024;
export const MAX_CONFORMANCE_NODES = 4096;
export const MAX_CONFORMANCE_DEPTH = 8;
export const MAX_CONFORMANCE_STRING_BYTES = 16 * 1024;

export function validateConformanceBounds(value: unknown): string[] {
  const issues: string[] = [];
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: "$", depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let aggregateBytes = 0;
  const add = (message: string): void => { if (issues.length < 128) issues.push(message); };
  while (stack.length > 0 && issues.length === 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_CONFORMANCE_NODES) { add(`$ exceeds the ${MAX_CONFORMANCE_NODES}-node conformance budget`); break; }
    if (current.depth > MAX_CONFORMANCE_DEPTH) { add(`${current.path} exceeds the maximum conformance nesting depth`); break; }
    if (typeof current.value === "string") {
      const bytes = Buffer.byteLength(current.value, "utf8");
      aggregateBytes += bytes;
      if (bytes > MAX_CONFORMANCE_STRING_BYTES) add(`${current.path} exceeds the ${MAX_CONFORMANCE_STRING_BYTES}-byte string limit`);
      if (aggregateBytes > MAX_CONFORMANCE_AGGREGATE_BYTES) add(`$ exceeds the ${MAX_CONFORMANCE_AGGREGATE_BYTES}-byte aggregate conformance budget`);
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) { add(`${current.path} contains a cyclic or repeated object`); break; }
    seen.add(current.value);
    let keys: string[];
    try {
      const prototype = Object.getPrototypeOf(current.value);
      if (Array.isArray(current.value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
        add(`${current.path} must use a plain object or array prototype`);
        break;
      }
      if (Array.isArray(current.value)) {
        const cap = current.path.endsWith(".entries") ? MAX_CONFORMANCE_ENTRIES
          : current.path.endsWith(".quality_gate_results") ? MAX_CONFORMANCE_QUALITY_GATES
            : current.path.endsWith(".blocking_findings") ? MAX_CONFORMANCE_FINDINGS
              : current.path.endsWith(".test_evidence") ? MAX_CONFORMANCE_TEST_EVIDENCE
                : current.path.endsWith(".evidence_refs") ? MAX_CONFORMANCE_EVIDENCE_REFS : MAX_CONFORMANCE_ENTRIES;
        if (current.value.length > cap) { add(`${current.path} exceeds the ${cap}-item conformance limit`); break; }
        for (let index = current.value.length - 1; index >= 0; index -= 1) stack.push({ value: current.value[index], path: `${current.path}[${index}]`, depth: current.depth + 1 });
        continue;
      }
      keys = Object.keys(current.value);
    } catch {
      add(`${current.path} could not be inspected safely`);
      break;
    }
    if (keys.length > MAX_CONFORMANCE_NODES) { add(`${current.path} contains too many properties`); break; }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({ value: (current.value as Record<string, unknown>)[key], path: `${current.path}.${key}`, depth: current.depth + 1 });
    }
  }
  return issues;
}
/**
 * Structural validation of one implementation-conformance result: matrix
 * subject uniqueness, pass-row evidence obligations, and status/finding
 * agreement. Cross-binding against the handoff/claim is separate
 * (`validateConformanceAgainstHandoff`).
 */
export function validateImplementationConformance(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  const budgetIssues = validateConformanceBounds(value);
  if (budgetIssues.length > 0) return { ok: false, issues: budgetIssues };
  if (!isRecord(value)) return { ok: false, issues: ["$ must be an object"] };
  const issues: string[] = [];
  unknownKeys(
    value,
    ["schema_version", "conformance_id", "matrix_digest", "feature_id", "handoff_id", "handoff_digest", "execution_claim_id", "execution_owner", "execution_run_id", "profile_hash", "evaluated_at", "entries", "quality_gate_results", "overall_status", "blocking_findings", "next_action"],
    "$",
    issues,
  );
  if (value.schema_version !== "1.0") issues.push("$.schema_version must be '1.0'");
  requireString(value, "conformance_id", "$", issues);
  requireDigest(value, "matrix_digest", "$", issues);
  requireString(value, "feature_id", "$", issues);
  const canonicalMatrixDigest = implementationConformanceMatrixDigest(value);
  if (canonicalMatrixDigest !== null && value.matrix_digest !== canonicalMatrixDigest) {
    issues.push(`$.matrix_digest must equal the canonical conformance matrix digest '${canonicalMatrixDigest}'`);
  }
  if (typeof value.conformance_id === "string" && typeof value.matrix_digest === "string"
    && value.conformance_id !== `implementation-conformance.${value.matrix_digest}`) {
    issues.push("$.conformance_id must equal implementation-conformance.<matrix_digest>");
  }
  requireString(value, "handoff_id", "$", issues);
  requireDigest(value, "handoff_digest", "$", issues);
  requireString(value, "execution_claim_id", "$", issues);
  requireEnum(value, "execution_owner", "$", issues, ["do_work", "cto"]);
  requireString(value, "execution_run_id", "$", issues);
  requireString(value, "profile_hash", "$", issues);
  requireString(value, "evaluated_at", "$", issues);
  requireEnum(value, "overall_status", "$", issues, ["pass", "blocked", "changed_intent"]);
  requireEnum(value, "next_action", "$", issues, CONFORMANCE_NEXT_ACTIONS);
  if (value.overall_status === "pass") {
    if (Array.isArray(value.blocking_findings) && value.blocking_findings.length > 0) {
      issues.push("$.blocking_findings must be empty when overall_status is pass");
    }
    if (value.next_action !== "complete_feature") {
      issues.push("$.next_action must be complete_feature when overall_status is pass");
    }
    if (!Array.isArray(value.entries) || value.entries.length === 0) {
      issues.push("$.entries must be non-empty when overall_status is pass");
    } else if (value.entries.some((entry: unknown) => !isRecord(entry) || entry.status !== "pass")) {
      issues.push("$.entries must all pass when overall_status is pass");
    }
    if (!Array.isArray(value.quality_gate_results) || value.quality_gate_results.length === 0) {
      issues.push("$.quality_gate_results must be non-empty when overall_status is pass");
    } else if (value.quality_gate_results.some((gate: unknown) => !isRecord(gate) || gate.status !== "pass")) {
      issues.push("$.quality_gate_results must all pass when overall_status is pass");
    }
  }

  if (!Array.isArray(value.entries)) {
    issues.push("$.entries must be an array");
  } else {
    const seenSubjects = new Set<string>();
    value.entries.forEach((entry, index) => {
      const entryPath = `$.entries[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${entryPath} must be an object`);
        return;
      }
      unknownKeys(
        entry,
        ["entry_id", "subject_kind", "subject_id", "requirement_id", "observable_behavior", "implementation_evidence_refs", "review_verdict", "review_evidence_refs", "test_evidence", "status", "findings"],
        entryPath,
        issues,
      );
      requireString(entry, "entry_id", entryPath, issues);
      requireString(entry, "subject_id", entryPath, issues);
      requireEnum(entry, "subject_kind", entryPath, issues, ["requirement", "acceptance_scenario"]);
      requireString(entry, "requirement_id", entryPath, issues);
      if (typeof entry.observable_behavior !== "boolean") issues.push(`${entryPath}.observable_behavior must be a boolean`);
      requireEnum(entry, "review_verdict", entryPath, issues, ["pass", "fail", "missing"]);
      requireEnum(entry, "status", entryPath, issues, ["pass", "blocked", "changed_intent"]);
      if (nonEmptyString(entry.subject_kind) && nonEmptyString(entry.subject_id)) {
        const subjectKey = `${String(entry.subject_kind)}:${String(entry.subject_id)}`;
        if (seenSubjects.has(subjectKey)) issues.push(`${entryPath} duplicates subject ${subjectKey}`);
        seenSubjects.add(subjectKey);
      }
      for (const refField of ["implementation_evidence_refs", "review_evidence_refs"] as const) {
        const refs = entry[refField];
        if (!Array.isArray(refs)) issues.push(`${entryPath}.${refField} must be an array`);
      }
      if (!Array.isArray(entry.test_evidence)) issues.push(`${entryPath}.test_evidence must be an array`);
      else {
        entry.test_evidence.forEach((evidence, evidenceIndex) => {
          const evidencePath = `${entryPath}.test_evidence[${evidenceIndex}]`;
          if (!isRecord(evidence)) {
            issues.push(`${evidencePath} must be an object`);
            return;
          }
          unknownKeys(evidence, ["evidence_ref", "test_kind", "status", "executed_at"], evidencePath, issues);
          requireEnum(evidence, "test_kind", evidencePath, issues, ["unit", "integration", "e2e", "runtime"]);
          requireEnum(evidence, "status", evidencePath, issues, ["pass", "fail"]);
          requireString(evidence, "executed_at", evidencePath, issues);
          if (!isRecord(evidence.evidence_ref)) issues.push(`${evidencePath}.evidence_ref must be an artifact reference object`);
        });
      }
      // Pass-row obligations: attributable implementation evidence, passing
      // review verdict, and (for observable behavior) passing executed tests.
      if (entry.status === "pass") {
        if (entry.review_verdict !== "pass") issues.push(`${entryPath} cannot pass without a passing review verdict`);
        if (!Array.isArray(entry.implementation_evidence_refs) || entry.implementation_evidence_refs.length === 0) {
          issues.push(`${entryPath} requires non-empty implementation evidence to pass`);
        }
        if (!Array.isArray(entry.review_evidence_refs) || entry.review_evidence_refs.length === 0) {
          issues.push(`${entryPath} requires non-empty review evidence to pass`);
        }
        if (entry.observable_behavior === true
          && (!Array.isArray(entry.test_evidence) || !entry.test_evidence.some((evidence: unknown) => isRecord(evidence) && evidence.status === "pass"))) {
          issues.push(`${entryPath} is observable behavior and requires passing executed-test evidence to pass`);
        }
      }
      if (!Array.isArray(entry.findings)) issues.push(`${entryPath}.findings must be an array`);
      else entry.findings.forEach((finding, findingIndex) => issues.push(...validateConformanceFinding(finding, `${entryPath}.findings[${findingIndex}]`)));
    });
  }

  if (!Array.isArray(value.quality_gate_results)) {
    issues.push("$.quality_gate_results must be an array");
  } else {
    value.quality_gate_results.forEach((gate, index) => {
      const gatePath = `$.quality_gate_results[${index}]`;
      if (!isRecord(gate)) {
        issues.push(`${gatePath} must be an object`);
        return;
      }
      unknownKeys(gate, ["gate_id", "source", "status", "evidence_refs", "findings"], gatePath, issues);
      requireString(gate, "gate_id", gatePath, issues);
      requireEnum(gate, "source", gatePath, issues, ["project_constitution", "execution_profile"]);
      requireEnum(gate, "status", gatePath, issues, ["pass", "fail"]);
      if (!Array.isArray(gate.evidence_refs)) issues.push(`${gatePath}.evidence_refs must be an array`);
      if (!Array.isArray(gate.findings)) issues.push(`${gatePath}.findings must be an array`);
      else gate.findings.forEach((finding, findingIndex) => issues.push(...validateConformanceFinding(finding, `${gatePath}.findings[${findingIndex}]`)));
    });
  }

  if (!Array.isArray(value.blocking_findings)) issues.push("$.blocking_findings must be an array");
  else value.blocking_findings.forEach((finding, index) => issues.push(...validateConformanceFinding(finding, `$.blocking_findings[${index}]`)));
  if (value.overall_status !== "pass") {
    if (!Array.isArray(value.blocking_findings) || value.blocking_findings.length === 0) {
      issues.push("$.blocking_findings must be non-empty when overall_status is not pass");
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function validateConformanceFinding(value: unknown, path: string): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return [`${path} must be an object`];
  unknownKeys(value, ["code", "subject_id", "message", "evidence_refs"], path, issues);
  requireString(value, "code", path, issues);
  requireString(value, "message", path, issues);
  requireStringOrNull(value, "subject_id", path, issues);
  requireStringArray(value, "evidence_refs", path, issues);
  return issues;
}

/**
 * Cross-binding of a conformance result to its frozen handoff and claim:
 * the subject set must exactly match the handoff, and handoff/owner
 * identities must agree with the claim.
 */
export function validateConformanceAgainstHandoff(
  result: ImplementationConformanceResult,
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const expectedSubjects = new Set<string>();
  const acceptanceOwners = new Map<string, string>();
  for (const requirement of handoff.requirements) {
    expectedSubjects.add(`requirement:${requirement.requirement_id}`);
    for (const acceptance of requirement.acceptance_ids) {
      expectedSubjects.add(`acceptance_scenario:${acceptance}`);
      acceptanceOwners.set(acceptance, requirement.requirement_id);
    }
  }
  const actualSubjects = new Set<string>();
  for (const [index, entry] of result.entries.entries()) {
    const subject = `${entry.subject_kind}:${entry.subject_id}`;
    if (actualSubjects.has(subject)) issues.push(`$.entries[${index}] duplicates closure row ${subject}`);
    actualSubjects.add(subject);
    const expectedRequirementId = entry.subject_kind === "requirement"
      ? entry.subject_id
      : acceptanceOwners.get(entry.subject_id);
    if (expectedRequirementId === undefined) {
      issues.push(`$.entries[${index}].requirement_id cannot be resolved for ${subject}`);
    } else if (entry.requirement_id !== expectedRequirementId) {
      issues.push(`$.entries[${index}].requirement_id must be '${expectedRequirementId}' for ${subject}`);
    }
  }
  for (const subject of expectedSubjects) {
    if (!actualSubjects.has(subject)) issues.push(`$.entries is missing the closure row for ${subject}`);
  }
  for (const subject of actualSubjects) {
    if (!expectedSubjects.has(subject)) issues.push(`$.entries has an extra closure row ${subject} that is not approved in the handoff`);
  }
  // Observable-behavior is copied from the frozen verification obligations.
  const observableBySubject = new Set<string>();
  for (const verification of handoff.verification) {
    if (!verification.observable_behavior) continue;
    for (const requirementId of verification.requirement_ids) observableBySubject.add(`requirement:${requirementId}`);
    for (const acceptanceId of verification.acceptance_ids) observableBySubject.add(`acceptance_scenario:${acceptanceId}`);
  }
  for (const entry of result.entries) {
    const expectedObservable = observableBySubject.has(`${entry.subject_kind}:${entry.subject_id}`);
    if (entry.observable_behavior !== expectedObservable) {
      issues.push(`$.entries[${entry.entry_id}].observable_behavior must copy the frozen verification obligation (${expectedObservable})`);
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

// ── Traceability checks ──────────────────────────────────────────────────────

/** Assemble one traceability finding with the canonical empty-evidence shape. */
function finding(
  code: string,
  subjectId: string | null,
  message: string,
  severity: ValidationFinding["severity"] = "blocking",
): ValidationFinding {
  return { code, severity, subject_id: subjectId, message, evidence_refs: [], remediation: null };
}

/**
 * Reusable traceability completeness checks over the canonical link inputs.
 * Emits one actionable finding per broken link; the handoff validator uses
 * the same rules fail-closed before readiness.
 */
export function checkTraceability(input: {
  requirements: HandoffRequirement[];
  decisions: HandoffDecision[];
  tasks: ImplementationTask[];
  verification: HandoffVerification[];
}): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const requirementIds = new Set(input.requirements.map((requirement) => requirement.requirement_id));
  const taskIds = new Set(input.tasks.map((task) => task.task_id));
  const acceptanceIds = new Set(input.requirements.flatMap((requirement) => requirement.acceptance_ids));
  const decisionsByRequirement = new Set<string>();
  const tasksByRequirement = new Set<string>();
  const verificationByRequirement = new Set<string>();
  const verificationByAcceptance = new Set<string>();
  let work = 0;
  let workLimitReported = false;
  const consume = (units = 1): boolean => {
    work += units;
    if (work <= 1_048_576) return true;
    if (!workLimitReported) {
      findings.push(finding("SPEC_TRACEABILITY_WORK_LIMIT", null, "Traceability coverage work exceeds the bounded validation budget"));
      workLimitReported = true;
    }
    return false;
  };

  for (const decision of input.decisions) {
    if (!consume()) break;
    for (const requirementId of decision.requirement_ids) {
      if (!consume()) break;
      decisionsByRequirement.add(requirementId);
    }
  }
  for (const task of input.tasks) {
    if (!consume()) break;
    for (const requirementId of task.requirement_ids) {
      if (!consume()) break;
      tasksByRequirement.add(requirementId);
    }
  }
  for (const verification of input.verification) {
    if (!consume()) break;
    for (const requirementId of verification.requirement_ids) {
      if (!consume()) break;
      verificationByRequirement.add(requirementId);
    }
    for (const acceptanceId of verification.acceptance_ids) {
      if (!consume()) break;
      verificationByAcceptance.add(acceptanceId);
    }
  }
  for (const requirement of input.requirements) {
    if (!consume()) break;
    if (requirement.acceptance_ids.length === 0) {
      findings.push(finding("SPEC_REQUIREMENT_WITHOUT_ACCEPTANCE", requirement.requirement_id, `Requirement '${requirement.requirement_id}' has no acceptance scenario`));
    }
    if (!decisionsByRequirement.has(requirement.requirement_id)) {
      findings.push(finding("SPEC_REQUIREMENT_WITHOUT_DECISION", requirement.requirement_id, `Requirement '${requirement.requirement_id}' has no linked Plan decision`));
    }
    if (!tasksByRequirement.has(requirement.requirement_id)) {
      findings.push(finding("SPEC_REQUIREMENT_WITHOUT_TASK", requirement.requirement_id, `Requirement '${requirement.requirement_id}' has no linked implementation task`));
    }
    if (!verificationByRequirement.has(requirement.requirement_id)) {
      findings.push(finding("SPEC_REQUIREMENT_WITHOUT_VERIFICATION", requirement.requirement_id, `Requirement '${requirement.requirement_id}' has no verification obligation`));
    }
    for (const acceptance of requirement.acceptance_ids) {
      if (!consume()) break;
      if (!verificationByAcceptance.has(acceptance)) {
        findings.push(finding("SPEC_ACCEPTANCE_NOT_VERIFIED", acceptance, `Acceptance scenario '${acceptance}' has no verification obligation`));
      }
    }
  }
  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const task of input.tasks) {
    if (!consume()) break;
    indegree.set(task.task_id, 0);
    edges.set(task.task_id, []);
  }
  for (const task of input.tasks) {
    if (!consume()) break;
    for (const dependency of task.depends_on) {
      if (!consume()) break;
      if (dependency === task.task_id) {
        findings.push(finding("SPEC_TASK_DEPENDENCY_CYCLE", task.task_id, `Task '${task.task_id}' depends on itself`));
        continue;
      }
      if (!taskIds.has(dependency)) {
        findings.push(finding("SPEC_TASK_DANGLING_DEPENDENCY", task.task_id, `Task '${task.task_id}' depends on unknown task '${dependency}'`));
        continue;
      }
      edges.get(task.task_id)!.push(dependency);
      indegree.set(dependency, (indegree.get(dependency) ?? 0) + 1);
    }
  }
  // Kahn's algorithm; leftover nodes sit on a cycle.
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  const seen = new Set<string>(queue);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (!consume()) break;
    for (const dependency of edges.get(queue[cursor]!) ?? []) {
      if (!consume()) break;
      const degree = (indegree.get(dependency) ?? 0) - 1;
      indegree.set(dependency, degree);
      if (degree === 0 && !seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }
  for (const task of input.tasks) {
    if (!consume()) break;
    if (!seen.has(task.task_id)) {
      findings.push(finding("SPEC_TASK_DEPENDENCY_CYCLE", task.task_id, `Task '${task.task_id}' sits on a dependency cycle`));
      break;
    }
  }
  for (const verification of input.verification) {
    if (!consume()) break;
    for (const requirementId of verification.requirement_ids) {
      if (!consume()) break;
      if (!requirementIds.has(requirementId)) {
        findings.push(finding("SPEC_VERIFICATION_UNKNOWN_REQUIREMENT", verification.verification_id, `Verification '${verification.verification_id}' references unknown requirement '${requirementId}'`));
      }
    }
    for (const acceptanceId of verification.acceptance_ids) {
      if (!consume()) break;
      if (!acceptanceIds.has(acceptanceId)) {
        findings.push(finding("SPEC_VERIFICATION_UNKNOWN_ACCEPTANCE", verification.verification_id, `Verification '${verification.verification_id}' references unknown acceptance scenario '${acceptanceId}'`));
      }
    }
    for (const taskId of verification.task_ids) {
      if (!consume()) break;
      if (!taskIds.has(taskId)) {
        findings.push(finding("SPEC_VERIFICATION_UNKNOWN_TASK", verification.verification_id, `Verification '${verification.verification_id}' references unknown task '${taskId}'`));
      }
    }
  }
  return findings;
}

// ── Native Specify / Plan / Tasks validation (T031–T033) ────────────────────

export interface NativePhaseVersionBinding { artifact_id: string; version: number; hash: string; }
export interface NativeRequirementInput {
  requirement_id: string;
  statement: string;
  acceptance_ids: string[];
  source_refs?: string[];
  testable?: boolean;
  untestable_reason?: string | null;
}
export interface NativeDecisionInput { decision_id: string; decision: string; rationale: string; requirement_ids: string[]; }
export interface NativeTaskInput {
  task_id?: string; id?: string; title: string; requirement_ids: string[]; acceptance_ids: string[];
  decision_ids: string[]; verification_ids: string[]; depends_on: string[]; expected_outcome: string;
  affected_scope: string[]; completion_evidence: string[]; parallel_safe: boolean;
}
export interface NativeVerificationInput { verification_id: string; requirement_ids: string[]; acceptance_ids: string[]; task_ids: string[]; observable_behavior: boolean; expected_evidence: string; }
export interface NativeContradictionInput {
  contradiction_id: string;
  subject_ids: string[];
  status: "resolved" | "accepted" | "unresolved";
  assessment: string;
  evidence: string;
}

/** Fully explicit input. No active-feature, filesystem, or wall-clock lookup is permitted. */
export interface NativePhaseValidationInput {
  validation_id: string; feature_id: string; run_key: string; phase: "specify" | "plan" | "tasks";
  version: number; artifact_version: string; document_path: string; document_sha256: string;
  /** Bounded observations of exact section bodies; never the authority. */
  sections: Record<string, string>; upstream_versions: NativePhaseVersionBinding[];
  expected_upstream_versions: NativePhaseVersionBinding[]; constitution_binding: ConstitutionBinding;
  expected_constitution_binding: ConstitutionBinding; constitution_principles: ConstitutionPrincipleResult[];
  requirements: NativeRequirementInput[]; decisions: NativeDecisionInput[]; tasks: NativeTaskInput[];
  verification: NativeVerificationInput[]; contradictions: NativeContradictionInput[];
  validated_at: string; validator_version?: string;
}

export const MAX_NATIVE_VALIDATION_WORK = 1_048_576;
const NATIVE_VALIDATOR_VERSION = "specification-validation@3";
const SPECIFY_SECTIONS = ["problem", "scope", "non_goals", "actors", "journeys", "requirements", "edge_cases", "assumptions", "dependencies", "success_criteria"] as const;
const PLAN_SECTIONS = ["repository_grounding", "decisions", "alternatives", "contracts", "data_flow", "control_flow", "migration", "security", "operations", "verification_strategy", "constitution_recheck"] as const;
const TASK_SECTIONS = ["task_graph", "dependencies", "expected_outcomes"] as const;

type RequirementMap = Map<string, NativeRequirementInput>;
type DecisionMap = Map<string, NativeDecisionInput>;
type TaskMap = Map<string, NativeTaskInput>;
type VerificationMap = Map<string, NativeVerificationInput>;

/**
 * Canonical indexes built once before entering the durable state lock. Every
 * validator lookup consumes the same maps/sets; no nested array scans are
 * permitted on the hot path.
 */
export interface NativeValidationIndexes {
  requirementsById: RequirementMap;
  acceptanceIds: Set<string>;
  decisionsById: DecisionMap;
  decisionsByRequirement: Map<string, Set<string>>;
  tasksById: TaskMap;
  taskIdsByRequirement: Map<string, Set<string>>;
  taskIdsByAcceptance: Map<string, Set<string>>;
  taskIdsByDecision: Map<string, Set<string>>;
  taskIdsByVerification: Map<string, Set<string>>;
  dependencies: Map<string, string[]>;
  verificationsById: VerificationMap;
  verificationsByRequirement: Map<string, Set<string>>;
  verificationsByAcceptance: Map<string, Set<string>>;
  constitutionById: Map<string, ConstitutionPrincipleResult>;
  contradictionsById: Map<string, NativeContradictionInput>;
  readonly operation_count: number;
  readonly budget_exceeded: boolean;
  consume(units?: number): boolean;
}

export type NativeValidationPreparation =
  | { ok: true; indexes: NativeValidationIndexes }
  | { ok: false; error: string };

function taskId(task: NativeTaskInput): string { return nonEmptyString(task.task_id) ? task.task_id : nonEmptyString(task.id) ? task.id : ""; }
function nativeFinding(code: string, location: string, message: string, remediation: string, evidenceRefs: string[] = []): ValidationFinding {
  return { code, severity: "blocking", subject_id: location, message, evidence_refs: evidenceRefs, remediation };
}
function nativeLocation(input: NativePhaseValidationInput, section: string): string { return `${input.document_path}#${section.replaceAll("_", "-")}`; }
function sectionPresent(input: NativePhaseValidationInput, section: string): boolean { return nonEmptyString(input.sections[section]); }

function prepareNativeIndexes(input: NativePhaseValidationInput, maxWork = MAX_NATIVE_VALIDATION_WORK): NativeValidationPreparation {
  let work = 0;
  let exceeded = false;
  const consume = (units = 1): boolean => {
    if (!Number.isSafeInteger(units) || units < 0 || work > maxWork - units) { exceeded = true; return false; }
    work += units;
    return true;
  };
  const requirementsById: RequirementMap = new Map();
  const acceptanceIds = new Set<string>();
  const decisionsById: DecisionMap = new Map();
  const decisionsByRequirement = new Map<string, Set<string>>();
  const tasksById: TaskMap = new Map();
  const taskIdsByRequirement = new Map<string, Set<string>>();
  const taskIdsByAcceptance = new Map<string, Set<string>>();
  const taskIdsByDecision = new Map<string, Set<string>>();
  const taskIdsByVerification = new Map<string, Set<string>>();
  const dependencies = new Map<string, string[]>();
  const verificationsById: VerificationMap = new Map();
  const verificationsByRequirement = new Map<string, Set<string>>();
  const verificationsByAcceptance = new Map<string, Set<string>>();
  const constitutionById = new Map<string, ConstitutionPrincipleResult>();
  const contradictionsById = new Map<string, NativeContradictionInput>();
  const addTo = (map: Map<string, Set<string>>, key: string, value: string): void => {
    const values = map.get(key) ?? new Set<string>();
    values.add(value);
    map.set(key, values);
  };
  const countString = (value: unknown): boolean => typeof value !== "string" || consume(Buffer.byteLength(value, "utf8"));
  const countStrings = (values: unknown): boolean => {
    if (!Array.isArray(values) || !consume(1)) return false;
    for (const value of values) if (!countString(value)) return false;
    return true;
  };
  if (!isRecord(input) || !isRecord(input.sections)) return { ok: false, error: "validation payload must contain bounded sections" };
  for (const [key, value] of Object.entries(input.sections)) {
    if (!consume(Buffer.byteLength(key, "utf8")) || !countString(value)) return { ok: false, error: "validation semantic work exceeds the bounded budget" };
  }
  if (!Array.isArray(input.requirements) || !Array.isArray(input.decisions) || !Array.isArray(input.tasks) || !Array.isArray(input.verification) || !Array.isArray(input.constitution_principles) || !Array.isArray(input.contradictions)) {
    return { ok: false, error: "validation payload semantic arrays are malformed" };
  }
  if (input.requirements.length > 4096 || input.decisions.length > 4096 || input.tasks.length > 4096 || input.verification.length > 4096 || input.constitution_principles.length > 4096 || input.contradictions.length > 4096) {
    return { ok: false, error: "validation semantic arrays exceed the bounded item budget" };
  }
  for (const requirement of input.requirements) {
    if (!consume() || !isRecord(requirement) || !countString(requirement.requirement_id) || !countString(requirement.statement) || !countStrings(requirement.acceptance_ids) || !countStrings(requirement.source_refs ?? []) || (requirement.untestable_reason !== null && requirement.untestable_reason !== undefined && !countString(requirement.untestable_reason))) return { ok: false, error: "validation semantic work exceeds the bounded budget" };
    requirementsById.set(typeof requirement.requirement_id === "string" ? requirement.requirement_id : "", requirement);
    for (const acceptance of Array.isArray(requirement.acceptance_ids) ? requirement.acceptance_ids : []) if (typeof acceptance === "string") acceptanceIds.add(acceptance);
  }
  for (const decision of input.decisions) {
    if (!consume() || !isRecord(decision) || !countString(decision.decision_id) || !countString(decision.decision) || !countString(decision.rationale) || !countStrings(decision.requirement_ids)) return { ok: false, error: "validation semantic work exceeds the bounded budget" };
    decisionsById.set(typeof decision.decision_id === "string" ? decision.decision_id : "", decision);
    for (const requirement of Array.isArray(decision.requirement_ids) ? decision.requirement_ids : []) if (typeof requirement === "string") addTo(decisionsByRequirement, requirement, typeof decision.decision_id === "string" ? decision.decision_id : "");
  }
  for (const task of input.tasks) {
    if (!consume() || !isRecord(task) || !countString(taskId(task)) || !countString(task.title) || !countStrings(task.requirement_ids) || !countStrings(task.acceptance_ids) || !countStrings(task.decision_ids) || !countStrings(task.verification_ids) || !countStrings(task.depends_on) || !countString(task.expected_outcome) || !countStrings(task.affected_scope) || !countStrings(task.completion_evidence) || !consume()) return { ok: false, error: "validation semantic work exceeds the bounded budget" };
    const id = taskId(task);
    tasksById.set(id, task);
    dependencies.set(id, Array.isArray(task.depends_on) ? task.depends_on.filter((entry): entry is string => typeof entry === "string") : []);
    for (const requirement of Array.isArray(task.requirement_ids) ? task.requirement_ids : []) if (typeof requirement === "string") addTo(taskIdsByRequirement, requirement, id);
    for (const acceptance of Array.isArray(task.acceptance_ids) ? task.acceptance_ids : []) if (typeof acceptance === "string") addTo(taskIdsByAcceptance, acceptance, id);
    for (const decision of Array.isArray(task.decision_ids) ? task.decision_ids : []) if (typeof decision === "string") addTo(taskIdsByDecision, decision, id);
    for (const verification of Array.isArray(task.verification_ids) ? task.verification_ids : []) if (typeof verification === "string") addTo(taskIdsByVerification, verification, id);
  }
  for (const verification of input.verification) {
    if (!consume() || !isRecord(verification) || !countString(verification.verification_id) || !countStrings(verification.requirement_ids) || !countStrings(verification.acceptance_ids) || !countStrings(verification.task_ids) || !countString(verification.expected_evidence) || !consume()) return { ok: false, error: "validation semantic work exceeds the bounded budget" };
    const id = typeof verification.verification_id === "string" ? verification.verification_id : "";
    verificationsById.set(id, verification);
    for (const requirement of Array.isArray(verification.requirement_ids) ? verification.requirement_ids : []) if (typeof requirement === "string") addTo(verificationsByRequirement, requirement, id);
    for (const acceptance of Array.isArray(verification.acceptance_ids) ? verification.acceptance_ids : []) if (typeof acceptance === "string") addTo(verificationsByAcceptance, acceptance, id);
  }
  for (const principle of input.constitution_principles) {
    if (!consume() || !isRecord(principle) || !countString(principle.principle_id) || !countString(principle.evidence)) return { ok: false, error: "validation semantic work exceeds the bounded budget" };
    constitutionById.set(typeof principle.principle_id === "string" ? principle.principle_id : "", principle);
  }
  for (const contradiction of input.contradictions) {
    if (!consume() || !isRecord(contradiction) || !countString(contradiction.contradiction_id) || !countStrings(contradiction.subject_ids) || !countString(contradiction.assessment) || !countString(contradiction.evidence) || !consume()) return { ok: false, error: "validation semantic work exceeds the bounded budget" };
    contradictionsById.set(typeof contradiction.contradiction_id === "string" ? contradiction.contradiction_id : "", contradiction);
  }
  for (const [key, values] of [...decisionsByRequirement, ...taskIdsByRequirement, ...taskIdsByAcceptance, ...taskIdsByDecision, ...taskIdsByVerification, ...verificationsByRequirement, ...verificationsByAcceptance]) {
    if (!consume() || !countString(key) || !consume(values.size)) return { ok: false, error: "validation semantic work exceeds the bounded budget" };
  }
  if (!consume(requirementsById.size + acceptanceIds.size + decisionsById.size + tasksById.size + verificationsById.size + constitutionById.size + contradictionsById.size + dependencies.size)) return { ok: false, error: "validation semantic work exceeds the bounded budget" };
  const indexes: NativeValidationIndexes = {
    requirementsById, acceptanceIds, decisionsById, decisionsByRequirement, tasksById,
    taskIdsByRequirement, taskIdsByAcceptance, taskIdsByDecision, taskIdsByVerification,
    dependencies, verificationsById, verificationsByRequirement, verificationsByAcceptance,
    constitutionById, contradictionsById,
    get operation_count() { return work; },
    get budget_exceeded() { return exceeded; },
    consume(units = 1) { return consume(units); },
  };
  return { ok: true, indexes };
}

/** Build canonical indexes before the durable state lock. */
export function prepareNativePhaseValidation(input: NativePhaseValidationInput, maxWork = MAX_NATIVE_VALIDATION_WORK): NativeValidationPreparation {
  return prepareNativeIndexes(input, maxWork);
}

function validateNativeVersionBindings(bindings: unknown): boolean {
  if (!Array.isArray(bindings)) return false;
  const ids = new Set<string>();
  return bindings.every((binding) => {
    if (!isRecord(binding) || !nonEmptyString(binding.artifact_id) || ids.has(binding.artifact_id)
      || !Number.isInteger(binding.version) || (binding.version as number) < 1 || !isSha256Hex(binding.hash)) return false;
    ids.add(binding.artifact_id); return true;
  });
}
function validateNativeBinding(input: NativePhaseValidationInput, indexes: NativeValidationIndexes): ValidationFinding[] {
  const out: ValidationFinding[] = []; const evidence = [input.document_path];
  if (!isSafeFeatureId(input.feature_id)) out.push(nativeFinding("SPEC_BINDING_FEATURE_INVALID", "feature_id", "Validation lacks a safe explicit feature_id.", "supply the immutable feature_id explicitly and regenerate", evidence));
  if (!nonEmptyString(input.run_key)) out.push(nativeFinding("SPEC_BINDING_RUN_MISSING", "run_key", "Validation lacks an explicit run_key.", "supply the originating run_key explicitly and regenerate", evidence));
  if (!Number.isInteger(input.version) || input.version < 1) out.push(nativeFinding("SPEC_BINDING_VERSION_INVALID", "version", "Artifact version must be a positive integer.", "create a new immutable positive phase version", evidence));
  const expectedVersion = `${input.phase}.v${input.version}`;
  if (input.artifact_version !== expectedVersion) out.push(nativeFinding("SPEC_BINDING_VERSION_MISMATCH", "artifact_version", `Artifact '${input.artifact_version}' does not match '${expectedVersion}'.`, `validate exact artifact '${expectedVersion}'`, evidence));
  if (!isSafeRelativePath(input.document_path)) out.push(nativeFinding("SPEC_BINDING_DOCUMENT_PATH_INVALID", "document_path", "Document path is not project-relative and safe.", "materialize inside the explicit feature workspace"));
  if (!isSha256Hex(input.document_sha256)) out.push(nativeFinding("SPEC_BINDING_DOCUMENT_HASH_INVALID", input.document_path, "Document has no valid SHA-256 binding.", "capture the exact document SHA-256 and revalidate", evidence));
  if (validateConstitutionBinding(input.constitution_binding).length > 0 || validateConstitutionBinding(input.expected_constitution_binding).length > 0
    || canonicalJson(input.constitution_binding) !== canonicalJson(input.expected_constitution_binding)) {
    out.push(nativeFinding("SPEC_BINDING_CONSTITUTION_MISMATCH", "constitution_binding", "Phase is not bound to the exact current constitution version and hashes.", "regenerate against the current constitution binding", [input.expected_constitution_binding.validation_ref]));
  }
  if (!validateNativeVersionBindings(input.upstream_versions) || !validateNativeVersionBindings(input.expected_upstream_versions)
    || canonicalJson(input.upstream_versions) !== canonicalJson(input.expected_upstream_versions)) {
    out.push(nativeFinding("SPEC_BINDING_UPSTREAM_MISMATCH", "upstream_versions", "Phase does not bind the exact approved upstream versions and hashes.", "regenerate from the exact current approved upstream versions", input.expected_upstream_versions.map((item) => item.artifact_id)));
  }
  if (input.phase === "specify" && input.expected_upstream_versions.length !== 0) out.push(nativeFinding("SPEC_BINDING_SPECIFY_HAS_UPSTREAM", "upstream_versions", "Specify cannot consume an upstream phase.", "remove the unexpected upstream binding"));
  if (input.phase !== "specify" && input.expected_upstream_versions.length === 0) out.push(nativeFinding("SPEC_BINDING_UPSTREAM_MISSING", "upstream_versions", `${input.phase} requires an exact approved upstream binding.`, `bind ${input.phase} to its exact approved upstream artifact`));
  if (indexes.budget_exceeded) out.push(nativeFinding("SPEC_VALIDATION_WORK_LIMIT", input.document_path, "Validation exceeded the bounded semantic work budget.", "reduce the phase model and retry", evidence));
  return out;
}
function requiredSections(input: NativePhaseValidationInput, sections: readonly string[]): ValidationFinding[] {
  return sections.filter((section) => !sectionPresent(input, section)).map((section) => nativeFinding("SPEC_VALIDATE_SECTIONS_MISSING", nativeLocation(input, section), `Mandatory ${input.phase} section '${section.replaceAll("_", " ")}' is missing or empty.`, `restore the '${section.replaceAll("_", " ")}' section before revalidation`, [input.document_path]));
}
function validateConstitutionObservations(input: NativePhaseValidationInput, indexes: NativeValidationIndexes): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  if (input.constitution_principles.length === 0 || indexes.constitutionById.size !== input.constitution_principles.length) {
    out.push(nativeFinding("SPEC_CONSTITUTION_PRINCIPLE_SET_INVALID", "constitution_principles", "Constitution observations must contain the exact derived principle identity set without duplicates or omissions.", "regenerate observations from the approved constitution artifact", [input.expected_constitution_binding.validation_ref]));
  }
  for (const principle of input.constitution_principles) {
    if (!isRecord(principle) || !nonEmptyString(principle.principle_id) || !nonEmptyString(principle.evidence) || (principle.status !== "pass" && principle.status !== "not_applicable")) {
      out.push(nativeFinding("SPEC_CONSTITUTION_PRINCIPLE_OBSERVATION_INVALID", "constitution_principles", "Constitution observation is malformed or claims an unsupported status.", "attach evidence and a pass/not_applicable status to the derived principle id", [input.expected_constitution_binding.validation_ref]));
    }
  }
  return out;
}

function validateSpecifyContent(input: NativePhaseValidationInput, indexes: NativeValidationIndexes): ValidationFinding[] {
  const out = requiredSections(input, SPECIFY_SECTIONS);
  for (const contradiction of input.contradictions) {
    if (!indexes.consume()) break;
    if (!isRecord(contradiction) || !nonEmptyString(contradiction.contradiction_id) || !nonEmptyString(contradiction.assessment) || !nonEmptyString(contradiction.evidence) || contradiction.status === "unresolved") {
      const id = isRecord(contradiction) && nonEmptyString(contradiction.contradiction_id) ? contradiction.contradiction_id : "unknown";
      out.push(nativeFinding("SPEC_CONTRADICTION_UNRESOLVED", `${nativeLocation(input, "requirements")}:contradiction-${id}`, "Specify contains an unresolved or malformed contradiction assessment.", "resolve the contradictory requirements and record evidence", [input.document_path]));
    }
  }
  if (input.requirements.length === 0) { out.push(nativeFinding("SPEC_REQUIREMENTS_MISSING", nativeLocation(input, "requirements"), "Specify has no functional requirement.", "add stable testable requirements with acceptance ids", [input.document_path])); return out; }
  for (const [id, requirement] of indexes.requirementsById) {
    if (!indexes.consume()) break;
    const location = `${nativeLocation(input, "requirements")}:${id || "unknown"}`;
    if (!nonEmptyString(requirement.requirement_id) || indexes.requirementsById.get(id) !== requirement) out.push(nativeFinding("SPEC_REQUIREMENT_ID_INVALID", location, `Requirement '${id || "unknown"}' lacks a unique stable id.`, "assign one unique stable requirement_id", [input.document_path]));
    if (!nonEmptyString(requirement.statement)) out.push(nativeFinding("SPEC_REQUIREMENT_STATEMENT_MISSING", location, `Requirement '${id || "unknown"}' has no implementable statement.`, "write a precise observable statement", [input.document_path]));
    if (!Array.isArray(requirement.acceptance_ids) || requirement.acceptance_ids.length === 0 || requirement.acceptance_ids.some((item) => !nonEmptyString(item)) || requirement.testable === false || nonEmptyString(requirement.untestable_reason)) out.push(nativeFinding("SPEC_REQUIREMENT_UNTESTABLE", location, `Requirement '${id || "unknown"}' cannot yield deterministic pass/fail evidence.`, "add stable observable acceptance scenarios", [input.document_path]));
  }
  if (indexes.requirementsById.size !== input.requirements.length) out.push(nativeFinding("SPEC_REQUIREMENT_ID_INVALID", nativeLocation(input, "requirements"), "Specify contains duplicate requirement identifiers.", "assign one unique stable requirement_id per row", [input.document_path]));
  return out;
}
function validatePlanContent(input: NativePhaseValidationInput, indexes: NativeValidationIndexes): ValidationFinding[] {
  const out = requiredSections(input, PLAN_SECTIONS);
  const grounding = input.sections.repository_grounding;
  if (!nonEmptyString(grounding) || !/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+|package\.json|Cargo\.toml|build\.gradle(?:\.kts)?|pyproject\.toml/m.test(grounding)) out.push(nativeFinding("SPEC_PLAN_REPOSITORY_GROUNDING_MISSING", nativeLocation(input, "repository_grounding"), "Plan does not cite a concrete repository path or manifest.", "cite inspected files/modules and their conventions", [input.document_path]));
  if (input.decisions.length === 0) out.push(nativeFinding("SPEC_PLAN_DECISIONS_MISSING", nativeLocation(input, "decisions"), "Plan has no structured design decision.", "record decisions, rationale, alternatives, and requirement links", [input.document_path]));
  for (const [id, decision] of indexes.decisionsById) {
    if (!indexes.consume()) break;
    const location = `${nativeLocation(input, "decisions")}:${id || "unknown"}`;
    if (!nonEmptyString(id)) out.push(nativeFinding("SPEC_PLAN_DECISION_ID_INVALID", location, "Decision lacks a unique stable id.", "assign one unique decision_id", [input.document_path]));
    if (!nonEmptyString(decision.decision) || !nonEmptyString(decision.rationale)) out.push(nativeFinding("SPEC_PLAN_DECISION_INCOMPLETE", location, `Decision '${id || "unknown"}' lacks choice or rationale.`, "record the choice and rationale against alternatives", [input.document_path]));
    if (!Array.isArray(decision.requirement_ids) || decision.requirement_ids.length === 0 || decision.requirement_ids.some((item) => !indexes.requirementsById.has(item))) out.push(nativeFinding("SPEC_PLAN_DECISION_UNLINKED", location, `Decision '${id || "unknown"}' lacks valid requirement links.`, "link only approved Specify requirement ids", [input.document_path]));
  }
  if (indexes.decisionsById.size !== input.decisions.length) out.push(nativeFinding("SPEC_PLAN_DECISION_ID_INVALID", nativeLocation(input, "decisions"), "Plan contains duplicate decision identifiers.", "assign one unique decision_id per row", [input.document_path]));
  for (const id of indexes.requirementsById.keys()) if (!indexes.consume() || !(indexes.decisionsByRequirement.get(id)?.size ?? 0)) out.push(nativeFinding("SPEC_REQUIREMENT_WITHOUT_DECISION", id, `Requirement '${id}' has no Plan decision.`, "add a linked design decision", [input.document_path]));
  if (input.constitution_principles.length === 0) out.push(nativeFinding("SPEC_PLAN_CONSTITUTION_RECHECK_MISSING", nativeLocation(input, "constitution_recheck"), "Plan has no post-design constitution re-check.", "re-check every applicable principle", [input.expected_constitution_binding.validation_ref]));
  for (const principle of input.constitution_principles) if (!indexes.consume() || !nonEmptyString(principle.principle_id) || !nonEmptyString(principle.evidence) || principle.status === "fail") out.push(nativeFinding("SPEC_PLAN_CONSTITUTION_RECHECK_FAILED", nativeLocation(input, "constitution_recheck"), `Principle '${isRecord(principle) ? principle.principle_id || "unknown" : "unknown"}' did not pass the post-design re-check.`, "revise the design or justify not_applicable", [input.expected_constitution_binding.validation_ref]));
  return out;
}

function iterativeCycleNodes(indexes: NativeValidationIndexes): Set<string> {
  const colors = new Map<string, 0 | 1 | 2>();
  const parent = new Map<string, string | null>();
  const cycle = new Set<string>();
  const ids = [...indexes.tasksById.keys()].sort((left, right) => left.localeCompare(right));
  for (const root of ids) {
    if ((colors.get(root) ?? 0) !== 0) continue;
    colors.set(root, 1); parent.set(root, null);
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    while (stack.length > 0) {
      if (!indexes.consume()) return cycle;
      const frame = stack[stack.length - 1]!;
      const dependencies = indexes.dependencies.get(frame.id) ?? [];
      if (frame.next >= dependencies.length) { colors.set(frame.id, 2); stack.pop(); continue; }
      const dependency = dependencies[frame.next]!;
      frame.next += 1;
      if (!indexes.tasksById.has(dependency)) continue;
      const state = colors.get(dependency) ?? 0;
      if (state === 1) {
        cycle.add(dependency);
        let cursor: string | null = frame.id;
        while (cursor !== null && cursor !== dependency) { cycle.add(cursor); cursor = parent.get(cursor) ?? null; }
        continue;
      }
      if (state === 0) { colors.set(dependency, 1); parent.set(dependency, frame.id); stack.push({ id: dependency, next: 0 }); }
    }
  }
  return cycle;
}
function validateTasksContent(input: NativePhaseValidationInput, indexes: NativeValidationIndexes): ValidationFinding[] {
  const out = requiredSections(input, TASK_SECTIONS);
  if (input.tasks.length === 0) { out.push(nativeFinding("SPEC_TASK_GRAPH_EMPTY", nativeLocation(input, "task_graph"), "Tasks graph is empty.", "add the minimum complete task graph", [input.document_path])); return out; }
  for (const [id, task] of indexes.tasksById) {
    if (!indexes.consume()) break;
    const location = `${nativeLocation(input, "task_graph")}:${id || "unknown"}`;
    if (!nonEmptyString(id)) out.push(nativeFinding("SPEC_TASK_ID_INVALID", location, "Task lacks a unique stable id.", "assign one unique stable task id", [input.document_path]));
    const links: Array<[string, string[] | undefined, (id: string) => boolean, string]> = [["requirement", task.requirement_ids, (value) => indexes.requirementsById.has(value), "SPEC_TASK_REQUIREMENT_LINK_INVALID"], ["acceptance", task.acceptance_ids, (value) => indexes.acceptanceIds.has(value), "SPEC_TASK_ACCEPTANCE_LINK_INVALID"], ["decision", task.decision_ids, (value) => indexes.decisionsById.has(value), "SPEC_TASK_DECISION_LINK_INVALID"], ["verification", task.verification_ids, (value) => indexes.verificationsById.has(value), "SPEC_TASK_VERIFICATION_LINK_INVALID"]];
    for (const [label, values, known, code] of links) if (!Array.isArray(values) || values.length === 0 || values.some((item) => !nonEmptyString(item) || !known(item))) out.push(nativeFinding(code, location, `Task '${id || "unknown"}' lacks complete valid ${label} links.`, `link at least one approved ${label} id`, [input.document_path]));
    if (!Array.isArray(task.affected_scope) || task.affected_scope.length === 0 || task.affected_scope.some((item) => !nonEmptyString(item))) out.push(nativeFinding("SPEC_TASK_AFFECTED_SCOPE_MISSING", location, `Task '${id || "unknown"}' has no affected scope.`, "name affected files, modules, or components", [input.document_path]));
    if (!nonEmptyString(task.expected_outcome)) out.push(nativeFinding("SPEC_TASK_EXPECTED_OUTCOME_MISSING", location, `Task '${id || "unknown"}' has no expected outcome.`, "state the observable outcome", [input.document_path]));
    if (!Array.isArray(task.completion_evidence) || task.completion_evidence.length === 0 || task.completion_evidence.some((item) => !nonEmptyString(item))) out.push(nativeFinding("SPEC_TASK_EVIDENCE_MISSING", location, `Task '${id || "unknown"}' has no evidence obligation.`, "name the verification evidence", [input.document_path]));
    for (const dependency of indexes.dependencies.get(id) ?? []) if (!indexes.consume() || dependency === id) out.push(nativeFinding("SPEC_TASK_DEPENDENCY_CYCLE", `${nativeLocation(input, "dependencies")}:${id || "unknown"}`, `Task '${id || "unknown"}' depends on itself.`, "remove the self dependency", [input.document_path])); else if (!indexes.tasksById.has(dependency)) out.push(nativeFinding("SPEC_TASK_DANGLING_DEPENDENCY", `${nativeLocation(input, "dependencies")}:${id || "unknown"}`, `Task '${id || "unknown"}' depends on unknown '${dependency}'.`, "link only declared task ids", [input.document_path]));
  }
  if (indexes.tasksById.size !== input.tasks.length) out.push(nativeFinding("SPEC_TASK_ID_INVALID", nativeLocation(input, "task_graph"), "Tasks contain duplicate identifiers.", "assign one unique stable task id per row", [input.document_path]));
  for (const id of iterativeCycleNodes(indexes)) out.push(nativeFinding("SPEC_TASK_DEPENDENCY_CYCLE", `${nativeLocation(input, "dependencies")}:${id}`, `Task '${id}' participates in a cycle.`, "break the cycle to restore a DAG", [input.document_path]));
  const coverage: Array<[string, Iterable<string>, (id: string) => Set<string> | undefined, string]> = [["requirement", indexes.requirementsById.keys(), (id) => indexes.taskIdsByRequirement.get(id), "SPEC_REQUIREMENT_WITHOUT_TASK"], ["acceptance", indexes.acceptanceIds, (id) => indexes.taskIdsByAcceptance.get(id), "SPEC_ACCEPTANCE_WITHOUT_TASK"], ["decision", indexes.decisionsById.keys(), (id) => indexes.taskIdsByDecision.get(id), "SPEC_DECISION_WITHOUT_TASK"], ["verification", indexes.verificationsById.keys(), (id) => indexes.taskIdsByVerification.get(id), "SPEC_VERIFICATION_WITHOUT_TASK"]];
  for (const [label, expected, coveredBy, code] of coverage) for (const id of expected) if (!indexes.consume() || !(coveredBy(id)?.size ?? 0)) out.push(nativeFinding(code, id, `${label} '${id}' is not covered by a task.`, `link at least one task to this ${label}`, [input.document_path]));
  return out;
}
function nativeTraceability(input: NativePhaseValidationInput, indexes: NativeValidationIndexes): TraceabilitySummary | null {
  if (input.phase === "specify") return null;
  const missing: string[] = [];
  let decisionsLinked = 0;
  let tasksLinked = 0;
  let verificationLinked = 0;
  let requirementsWithAcceptance = 0;
  for (const [id, requirement] of indexes.requirementsById) {
    if (!indexes.consume()) break;
    if (requirement.acceptance_ids.length > 0) requirementsWithAcceptance += 1;
    const hasDecision = (indexes.decisionsByRequirement.get(id)?.size ?? 0) > 0;
    const hasTask = (indexes.taskIdsByRequirement.get(id)?.size ?? 0) > 0;
    const hasVerification = (indexes.verificationsByRequirement.get(id)?.size ?? 0) > 0;
    if (hasDecision) decisionsLinked += 1;
    if (hasTask) tasksLinked += 1;
    if (hasVerification) verificationLinked += 1;
    if (requirement.acceptance_ids.length === 0 || !hasDecision || (input.phase === "tasks" && (!hasTask || !hasVerification))) missing.push(id);
  }
  return { requirements_total: indexes.requirementsById.size, requirements_with_acceptance: requirementsWithAcceptance, decisions_linked: decisionsLinked, tasks_linked: tasksLinked, verification_linked: verificationLinked, missing_ids: missing.sort() };
}
function nativeCheck(id: string, findings: ValidationFinding[], evidence: string, remediation: string): ValidationCheck { return findings.length === 0 ? { check_id: id, status: "pass", evidence, remediation: null } : { check_id: id, status: "fail", evidence: findings.map((item) => `${item.subject_id ?? "artifact"}: ${item.message}`).join("; "), remediation }; }
/** Validate one exact native phase revision and emit its checkpoint-gating result. */
export function validateNativePhase(input: NativePhaseValidationInput, prepared?: NativeValidationIndexes): PhaseValidationResult {
  const preparation = prepared ? { ok: true as const, indexes: prepared } : prepareNativeIndexes(input);
  if (!preparation.ok) {
    const reason = "error" in preparation ? preparation.error : "validation preparation failed";
    return { validation_id: input.validation_id, phase: input.phase, artifact_version: input.artifact_version, status: "fail", checks: [{ check_id: "exact_bindings", status: "fail", evidence: reason, remediation: "reduce the phase model and regenerate" }, { check_id: `${input.phase}_content`, status: "fail", evidence: reason, remediation: "reduce the phase model and regenerate" }], blocking_findings: [nativeFinding("SPEC_VALIDATION_WORK_LIMIT", input.document_path, reason, "reduce the phase model and regenerate", [input.document_path])], warnings: [], constitution: { binding: input.constitution_binding, principles: input.constitution_principles }, traceability_summary: input.phase === "specify" ? null : { requirements_total: 0, requirements_with_acceptance: 0, decisions_linked: 0, tasks_linked: 0, verification_linked: 0, missing_ids: [] }, validator_version: input.validator_version ?? NATIVE_VALIDATOR_VERSION, validated_at: input.validated_at };
  }
  const indexes = preparation.indexes;
  const bindings = validateNativeBinding(input, indexes);
  const constitutionObservations = validateConstitutionObservations(input, indexes);
  let content: ValidationFinding[];
  switch (input.phase) { case "specify": content = validateSpecifyContent(input, indexes); break; case "plan": content = validatePlanContent(input, indexes); break; case "tasks": content = validateTasksContent(input, indexes); break; }
  const findings = [...bindings, ...constitutionObservations, ...content];
  if (indexes.budget_exceeded) findings.push(nativeFinding("SPEC_VALIDATION_WORK_LIMIT", input.document_path, "Validation exceeded the bounded semantic work budget.", "reduce the phase model and retry", [input.document_path]));
  return { validation_id: input.validation_id, phase: input.phase, artifact_version: input.artifact_version, status: findings.length === 0 ? "pass" : "fail", checks: [nativeCheck("exact_bindings", [...bindings, ...constitutionObservations], `Exact feature/run/version/upstream/constitution bindings verified for ${input.artifact_version}.`, "regenerate from exact current bindings"), nativeCheck(`${input.phase}_content`, content, `All mandatory ${input.phase} criteria passed.`, `repair located ${input.phase} criteria and revalidate`)], blocking_findings: findings, warnings: [], constitution: { binding: input.constitution_binding, principles: input.constitution_principles }, traceability_summary: nativeTraceability(input, indexes), validator_version: input.validator_version ?? NATIVE_VALIDATOR_VERSION, validated_at: input.validated_at };
}
export function validateSpecifyPhase(input: Omit<NativePhaseValidationInput, "phase">, prepared?: NativeValidationIndexes): PhaseValidationResult { return validateNativePhase({ ...input, phase: "specify" }, prepared); }
export function validatePlanPhase(input: Omit<NativePhaseValidationInput, "phase">, prepared?: NativeValidationIndexes): PhaseValidationResult { return validateNativePhase({ ...input, phase: "plan" }, prepared); }
export function validateTasksPhase(input: Omit<NativePhaseValidationInput, "phase">, prepared?: NativeValidationIndexes): PhaseValidationResult { return validateNativePhase({ ...input, phase: "tasks" }, prepared); }

export interface BlockingValidationOutcome { violations: Array<{ location: string; criterion: string; remediation_command: string | null }>; approval_proof: string | null; first_valid_next_action: WorkspaceNextAction; }
/** Deterministic checkpoint-safe projection; inconsistent results fail closed. */
export function blockingOutcome(result: PhaseValidationResult): BlockingValidationOutcome {
  const passing = result.status === "pass" && result.blocking_findings.length === 0 && result.checks.length > 0 && result.checks.every((item) => item.status === "pass") && nonEmptyString(result.validation_id) && nonEmptyString(result.artifact_version) && validateConstitutionBinding(result.constitution.binding).length === 0 && result.constitution.principles.length > 0 && result.constitution.principles.every((item) => item.status !== "fail" && nonEmptyString(item.evidence));
  if (passing) return { violations: [], approval_proof: `${result.validation_id} passed for exact artifact ${result.artifact_version} under constitution ${result.constitution.binding.content_sha256}`, first_valid_next_action: { kind: "checkpoint", command: null, reason: `Validation '${result.validation_id}' passed for '${result.artifact_version}'; the hard-human ${result.phase} checkpoint is the first valid next action.` } };
  const findings = result.blocking_findings.length > 0 ? result.blocking_findings : [nativeFinding("SPEC_VALIDATION_INCONSISTENT", result.artifact_version || result.phase, "Validation is malformed or claims pass without complete checks and constitution proof.", `rerun deterministic ${result.phase} validation for the exact current artifact`)];
  const violations = findings.map((item) => ({ location: item.subject_id ?? result.artifact_version, criterion: item.code, remediation_command: item.remediation }));
  return { violations, approval_proof: null, first_valid_next_action: { kind: "remediation", command: violations[0]?.remediation_command ?? null, reason: `Validation '${result.validation_id}' blocks ${result.phase} approval at '${violations[0]?.location ?? result.artifact_version}'.` } };
}

// ── Typed next actions ───────────────────────────────────────────────────────

const PHASE_ENTRY_COMMANDS: Record<string, string> = {
  specify: "/specify",
  plan: "/spec-plan",
  tasks: "/spec-tasks",
};

/**
 * Derive the typed next action for the readable projection from the current
 * phase records. Deterministic: identical inputs produce identical actions.
 */
export function nextActionForWorkspace(
  phases: WorkspacePhaseRecord[],
  context: { status: WorkspaceStatus; hasConstitutionBinding: boolean; sourceKind: FeatureWorkspace["source_kind"] },
): WorkspaceNextAction {
  if (context.status === "completed") {
    return { kind: "none", command: null, reason: "The feature is complete with a passing implementation conformance result." };
  }
  if (!context.hasConstitutionBinding) {
    return { kind: "remediation", command: "ensure_project_constitution", reason: "The project constitution prerequisite is unresolved; resolve or approve it before phase work." };
  }
  if (context.status === "stale") {
    return { kind: "remediation", command: null, reason: "A bound artifact changed; revalidate the affected phase before further dispatch." };
  }
  if (context.status === "blocked") {
    return { kind: "remediation", command: null, reason: "The workspace is blocked; repair the recorded blocker and resume explicitly." };
  }
  const order: WorkspacePhaseRecord["phase"][] = ["specify", "plan", "tasks"];
  for (const phase of order) {
    const record = phases.find((entry) => entry.phase === phase);
    if (!record) continue;
    switch (record.status) {
      case "awaiting_approval":
        return { kind: "checkpoint", command: null, reason: `The ${phase} validation passed; the hard-human checkpoint is open.` };
      case "revision_required":
        return { kind: "command", command: PHASE_ENTRY_COMMANDS[phase] ?? null, reason: `The ${phase} revision is required; re-enter the phase with the recorded feedback.` };
      case "stale":
        return { kind: "remediation", command: null, reason: `The ${phase} approval is stale; regenerate or revalidate the affected version.` };
      case "blocked":
        return { kind: "remediation", command: null, reason: `The ${phase} is blocked${record.stale_reason ? `: ${record.stale_reason}` : ""}; repair the prerequisite and resume.` };
      case "not_started":
        if (record.phase === "specify" || isPhaseReady(record, phases, order)) {
          return { kind: "command", command: PHASE_ENTRY_COMMANDS[phase] ?? null, reason: `Enter the ${phase} phase.` };
        }
        return { kind: "none", command: null, reason: `The ${phase} phase waits for its upstream approvals.` };
      case "generating":
      case "materialized":
      case "validating":
        return { kind: "none", command: null, reason: `The ${phase} phase work is in progress.` };
      case "approved":
        continue;
    }
  }
  return { kind: "none", command: null, reason: "No actionable phase state." };
}

function isPhaseReady(record: WorkspacePhaseRecord, phases: WorkspacePhaseRecord[], order: WorkspacePhaseRecord["phase"][]): boolean {
  const index = order.indexOf(record.phase);
  if (index === 0) return true;
  const upstream = phases.find((entry) => entry.phase === order[index - 1]);
  return Boolean(upstream && upstream.status === "approved");
}

// ── Import record validation (strict, reusable) ──────────────────────────────

export function validateImportSnapshot(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  if (!isRecord(value)) return { ok: false, issues: ["$ must be an object"] };
  const issues: string[] = [];
  unknownKeys(value, ["snapshot_id", "source_root", "source_root_identity", "limits", "intake_paths", "recognition_ref", "framework", "mapping_id", "mapping_version", "selected_paths", "ignored_candidates", "files", "source_revision", "document_language", "document_language_source", "redactions", "normalized_content_ref", "created_at"], "$", issues);
  requireString(value, "snapshot_id", "$", issues);
  requireString(value, "source_root", "$", issues);
  if (!isSafeExternalMetadata(value.source_root, 4096) || typeof value.source_root !== "string" || !value.source_root.startsWith("/")) issues.push("$.source_root must be a canonical absolute line-inert path");
  if (value.limits !== undefined) {
    const limitsValidation = validateImportLimits(value.limits);
    if (!limitsValidation.ok) issues.push(...limitsValidation.issues);
  }
  if (!isRecord(value.source_root_identity)) {
    issues.push("$.source_root_identity must be an object");
  } else {
    unknownKeys(value.source_root_identity, ["canonical_path", "dev", "ino", "mode"], "$.source_root_identity", issues);
    if (!isSafeExternalMetadata(value.source_root_identity.canonical_path, 4096) || typeof value.source_root_identity.canonical_path !== "string" || !value.source_root_identity.canonical_path.startsWith("/")) {
      issues.push("$.source_root_identity.canonical_path must be a canonical absolute line-inert path");
    } else if (typeof value.source_root === "string" && value.source_root_identity.canonical_path !== value.source_root) {
      issues.push("$.source_root_identity.canonical_path must equal source_root");
    }
    for (const key of ["dev", "ino", "mode"] as const) {
      if (!Number.isSafeInteger(value.source_root_identity[key]) || (value.source_root_identity[key] as number) < 0) {
        issues.push(`$.source_root_identity.${key} must be a bounded non-negative integer`);
      }
    }
  }
  if (!validateSafePathArray(value.intake_paths, "$.intake_paths", issues, { allowDot: true })) {
    issues.push("$.intake_paths must contain between 1 and 512 paths");
  } else if (value.intake_paths.length === 0) {
    issues.push("$.intake_paths must contain between 1 and 512 paths");
  }
  requireString(value, "recognition_ref", "$", issues);
  if (!isSafeCanonicalToken(value.framework)) issues.push("$.framework must be a bounded safe canonical token");
  if (!isSafeCanonicalToken(value.mapping_id)) issues.push("$.mapping_id must be a bounded safe canonical token");
  if (!isSafeCanonicalToken(value.mapping_version)) issues.push("$.mapping_version must be a bounded safe canonical token");
  validateSafePathArray(value.selected_paths, "$.selected_paths", issues);
  if (!Array.isArray(value.ignored_candidates)) {
    issues.push("$.ignored_candidates must be an array");
  } else if (value.ignored_candidates.length > IMPORT_MAX_FILES) {
    issues.push(`$.ignored_candidates exceeds the ${IMPORT_MAX_FILES}-entry bound`);
  } else {
    const seen = new Set<string>();
    let aggregateBytes = 0;
    value.ignored_candidates.forEach((entry, index) => {
      const ignoredPath = `$.ignored_candidates[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${ignoredPath} must be an object`);
        return;
      }
      unknownKeys(entry, ["path", "reason"], ignoredPath, issues);
      if (!isSafeRelativePath(entry.path)) issues.push(`${ignoredPath}.path must be a safe relative path`);
      else {
        aggregateBytes += Buffer.byteLength(entry.path, "utf8");
        if (seen.has(entry.path)) issues.push("$.ignored_candidates must not contain duplicate paths");
        seen.add(entry.path);
      }
      if (!isSafeExternalMetadata(entry.reason, 512)) issues.push(`${ignoredPath}.reason must be bounded line-inert metadata`);
      else aggregateBytes += Buffer.byteLength(entry.reason, "utf8");
    });
    if (aggregateBytes > IMPORT_MAX_PATH_AGGREGATE_BYTES) issues.push(`$.ignored_candidates exceeds the ${IMPORT_MAX_PATH_AGGREGATE_BYTES}-byte aggregate metadata bound`);
  }
  requireString(value, "normalized_content_ref", "$", issues);
  requireString(value, "created_at", "$", issues);
  requireStringOrNull(value, "source_revision", "$", issues);
  if (value.source_revision !== null && (typeof value.source_revision !== "string" || !isSafeExternalMetadata(value.source_revision, 256))) issues.push("$.source_revision must be null or bounded line-inert metadata");
  requireString(value, "document_language", "$", issues);
  if (typeof value.document_language !== "string" || value.document_language.length > 64 || !CANONICAL_LANGUAGE_RE.test(value.document_language)) issues.push("$.document_language must be a canonical BCP-47 language tag");
  requireString(value, "document_language_source", "$", issues);
  if (!["explicit", "metadata", "unknown"].includes(value.document_language_source as string)) issues.push("$.document_language_source must be explicit, metadata, or unknown");
  if (!Array.isArray(value.files)) {
    issues.push("$.files must be an array");
  } else if (value.files.length > IMPORT_MAX_FILES) {
    issues.push(`$.files exceeds the ${IMPORT_MAX_FILES}-entry bound`);
  } else {
    const seen = new Set<string>();
    let aggregateBytes = 0;
    value.files.forEach((entry, index) => {
      const filePath = `$.files[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${filePath} must be an object`);
        return;
      }
      unknownKeys(entry, ["path", "sha256", "size_bytes", "media_type"], filePath, issues);
      if (!isSafeRelativePath(entry.path)) issues.push(`${filePath}.path must be a safe relative path`);
      else {
        aggregateBytes += Buffer.byteLength(entry.path, "utf8");
        if (seen.has(entry.path)) issues.push("$.files must not contain duplicate paths");
        seen.add(entry.path);
      }
      requireDigest(entry, "sha256", filePath, issues);
      requirePositiveInt(entry, "size_bytes", filePath, issues);
      if (!isSafeExternalMetadata(entry.media_type, 512)) issues.push(`${filePath}.media_type must be bounded line-inert metadata`);
      else aggregateBytes += Buffer.byteLength(entry.media_type, "utf8");
    });
    if (aggregateBytes > IMPORT_MAX_PATH_AGGREGATE_BYTES) issues.push(`$.files exceeds the ${IMPORT_MAX_PATH_AGGREGATE_BYTES}-byte aggregate metadata bound`);
  }
  if (!Array.isArray(value.redactions)) {
    issues.push("$.redactions must be an array");
  } else if (value.redactions.length > IMPORT_MAX_REDACTIONS) {
    issues.push(`$.redactions exceeds the ${IMPORT_MAX_REDACTIONS}-entry bound`);
  } else {
    const seen = new Set<string>();
    let aggregateBytes = 0;
    value.redactions.forEach((entry, index) => {
      const redactionPath = `$.redactions[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${redactionPath} must be an object`);
        return;
      }
      unknownKeys(entry, ["path", "reason"], redactionPath, issues);
      if (!isSafeRelativePath(entry.path)) issues.push(`${redactionPath}.path must be a safe relative path`);
      else {
        aggregateBytes += Buffer.byteLength(entry.path, "utf8");
        if (seen.has(entry.path)) issues.push("$.redactions must not contain duplicate paths");
        seen.add(entry.path);
      }
      if (!isSafeExternalMetadata(entry.reason, 512)) issues.push(`${redactionPath}.reason must be bounded line-inert metadata`);
      else aggregateBytes += Buffer.byteLength(entry.reason, "utf8");
    });
    if (aggregateBytes > IMPORT_MAX_PATH_AGGREGATE_BYTES) issues.push(`$.redactions exceeds the ${IMPORT_MAX_PATH_AGGREGATE_BYTES}-byte aggregate metadata bound`);
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function validateCompatibilityReport(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  if (!isRecord(value)) return { ok: false, issues: ["$ must be an object"] };
  const issues: string[] = [];
  unknownKeys(value, ["report_id", "snapshot_ref", "constitution_binding", "status", "document_language", "document_language_source", "framework", "mapping_id", "mapping_version", "selected_paths", "mapping", "blocking_findings", "warnings", "ignored_content", "supplement_ref", "evaluated_at"], "$", issues);
  requireString(value, "report_id", "$", issues);
  requireString(value, "snapshot_ref", "$", issues);
  requireEnum(value, "status", "$", issues, ["ready", "supplement_required", "blocked", "unsupported"]);
  requireString(value, "framework", "$", issues);
  requireString(value, "document_language", "$", issues);
  if (typeof value.document_language !== "string" || value.document_language.length > 64 || !CANONICAL_LANGUAGE_RE.test(value.document_language)) issues.push("$.document_language must be a canonical BCP-47 language tag");
  requireString(value, "document_language_source", "$", issues);
  if (!["explicit", "metadata", "unknown"].includes(value.document_language_source as string)) issues.push("$.document_language_source must be explicit, metadata, or unknown");
  if (!isSafeCanonicalToken(value.framework)) issues.push("$.framework must be a bounded safe canonical token");
  requireString(value, "mapping_id", "$", issues);
  if (!isSafeCanonicalToken(value.mapping_id)) issues.push("$.mapping_id must be a bounded safe canonical token");
  requireString(value, "mapping_version", "$", issues);
  if (!isSafeCanonicalToken(value.mapping_version)) issues.push("$.mapping_version must be a bounded safe canonical token");
  validateSafePathArray(value.selected_paths, "$.selected_paths", issues);
  requireString(value, "evaluated_at", "$", issues);
  requireStringOrNull(value, "supplement_ref", "$", issues);
  issues.push(...validateConstitutionBinding(value.constitution_binding, "$.constitution_binding"));

  function validateCompatibilityFinding(value: unknown, path: string): void {
    if (!isRecord(value)) {
      issues.push(`${path} must be an object`);
      return;
    }
    unknownKeys(value, ["code", "subject_id", "message", "evidence_refs"], path, issues);
    if (!isSafeExternalMetadata(value.code, 128)) issues.push(`${path}.code must be bounded line-inert metadata`);
    if (value.subject_id !== null && !isSafeExternalMetadata(value.subject_id, 256)) issues.push(`${path}.subject_id must be null or bounded line-inert metadata`);
    if (!isSafeExternalMetadata(value.message, 512)) issues.push(`${path}.message must be bounded line-inert metadata`);
    if (!Array.isArray(value.evidence_refs)) issues.push(`${path}.evidence_refs must be an array`);
    else if (value.evidence_refs.length > IMPORT_MAX_FINDING_EVIDENCE) issues.push(`${path}.evidence_refs exceeds the ${IMPORT_MAX_FINDING_EVIDENCE}-entry bound`);
    else if (value.evidence_refs.some((ref: unknown) => !isSafeExternalMetadata(ref, 4096))) issues.push(`${path}.evidence_refs must contain bounded line-inert metadata`);
  }

  if (!Array.isArray(value.mapping)) issues.push("$.mapping must be an array");
  else if (value.mapping.length > IMPORT_MAX_MAPPINGS) issues.push(`$.mapping exceeds the ${IMPORT_MAX_MAPPINGS}-entry bound`);
  else value.mapping.forEach((entry, index) => {
    const mappingPath = `$.mapping[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${mappingPath} must be an object`);
      return;
    }
    unknownKeys(entry, ["source_ref", "contract_subject", "subject_id"], mappingPath, issues);
    if (!isSafeExternalMetadata(entry.source_ref, 4096)) issues.push(`${mappingPath}.source_ref must be bounded line-inert metadata`);
    if (!isSafeExternalMetadata(entry.contract_subject, 128)) issues.push(`${mappingPath}.contract_subject must be bounded line-inert metadata`);
    if (entry.subject_id !== null && !isSafeExternalMetadata(entry.subject_id, 256)) issues.push(`${mappingPath}.subject_id must be null or bounded line-inert metadata`);
  });
  if (!Array.isArray(value.blocking_findings)) issues.push("$.blocking_findings must be an array");
  else if (value.blocking_findings.length > IMPORT_MAX_FINDINGS) issues.push(`$.blocking_findings exceeds the ${IMPORT_MAX_FINDINGS}-entry bound`);
  else value.blocking_findings.forEach((entry, index) => validateCompatibilityFinding(entry, `$.blocking_findings[${index}]`));
  if (!Array.isArray(value.warnings)) issues.push("$.warnings must be an array");
  else if (value.warnings.length > IMPORT_MAX_FINDINGS) issues.push(`$.warnings exceeds the ${IMPORT_MAX_FINDINGS}-entry bound`);
  else value.warnings.forEach((entry, index) => validateCompatibilityFinding(entry, `$.warnings[${index}]`));
  if (!Array.isArray(value.ignored_content)) issues.push("$.ignored_content must be an array");
  else if (value.ignored_content.length > 512) issues.push("$.ignored_content exceeds the 512-entry bound");
  else value.ignored_content.forEach((entry, index) => {
    const candidatePath = `$.ignored_content[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${candidatePath} must be an object`);
      return;
    }
    unknownKeys(entry, ["path", "reason"], candidatePath, issues);
    if (!isSafeRelativePath(entry.path)) issues.push(`${candidatePath}.path must be a safe relative path`);
    if (!isSafeExternalMetadata(entry.reason, 512)) issues.push(`${candidatePath}.reason must be bounded line-inert metadata`);
  });
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

const IMPORT_SUPPLEMENT_MAX_SECTIONS = 256;
const IMPORT_SUPPLEMENT_MAX_SEMANTIC_ROWS = 512;
const IMPORT_SUPPLEMENT_MAX_NESTED_REFS = 128;
const IMPORT_SUPPLEMENT_MAX_STRING_LENGTH = 4096;
const IMPORT_SUPPLEMENT_MAX_AGGREGATE_BYTES = 512 * 1024;

export interface CompatibilitySupplementGraphOptions {
  readonly authorizedSourceRefs?: ReadonlySet<string>;
  readonly requirementIds?: ReadonlySet<string>;
  readonly taskIds?: ReadonlySet<string>;
}

function isExactPlainRecord(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isExactArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    return false;
  }
}

function validateCompatibilitySupplementShape(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  if (!isExactPlainRecord(value)) return { ok: false, issues: ["$ must be a plain JSON object"] };
  const issues: string[] = [];
  unknownKeys(value, [
    "schema_version", "supplement_id", "feature_id", "snapshot_id", "snapshot_ref",
    "source_sha256", "framework", "mapping_id", "mapping_version", "semantic_rows",
    "sections", "approved_by_ref", "approved_at", "content_sha256",
  ], "$", issues);
  if (value.schema_version !== 1) issues.push("$.schema_version must equal 1");
  requireString(value, "supplement_id", "$", issues);
  requireString(value, "feature_id", "$", issues);
  requireString(value, "snapshot_id", "$", issues);
  requireString(value, "snapshot_ref", "$", issues);
  requireDigest(value, "source_sha256", "$", issues);
  requireString(value, "framework", "$", issues);
  requireString(value, "mapping_id", "$", issues);
  requireString(value, "mapping_version", "$", issues);
  if (!isSafeCanonicalToken(value.framework)) issues.push("$.framework must be a bounded safe canonical token");
  if (!isSafeCanonicalToken(value.mapping_id)) issues.push("$.mapping_id must be a bounded safe canonical token");
  if (!isSafeCanonicalToken(value.mapping_version)) issues.push("$.mapping_version must be a bounded safe canonical token");
  requireString(value, "approved_by_ref", "$", issues);
  requireString(value, "approved_at", "$", issues);
  requireDigest(value, "content_sha256", "$", issues);

  let aggregateBytes = 0;
  const countString = (candidate: unknown, path: string, maxLength = IMPORT_SUPPLEMENT_MAX_STRING_LENGTH): void => {
    if (!isSafeExternalMetadata(candidate, maxLength)) {
      issues.push(`${path} must be bounded line-inert metadata`);
      return;
    }
    aggregateBytes += Buffer.byteLength(candidate, "utf8");
  };
  for (const key of ["supplement_id", "feature_id", "snapshot_id", "snapshot_ref", "framework", "mapping_id", "mapping_version", "approved_by_ref", "approved_at"] as const) {
    countString(value[key], `$.${key}`);
  }

  const seenSubjectIds = new Set<string>();
  const rowKinds = new Map<string, string>();
  const semanticRows = value.semantic_rows;
  if (!isExactArray(semanticRows) || semanticRows.length === 0) {
    issues.push("$.semantic_rows must be a non-empty plain array");
  } else if (semanticRows.length > IMPORT_SUPPLEMENT_MAX_SEMANTIC_ROWS) {
    issues.push(`$.semantic_rows exceeds the ${IMPORT_SUPPLEMENT_MAX_SEMANTIC_ROWS}-entry bound`);
  } else {
    semanticRows.forEach((entry, index) => {
      const rowPath = `$.semantic_rows[${index}]`;
      if (!isExactPlainRecord(entry)) {
        issues.push(`${rowPath} must be a plain JSON object`);
        return;
      }
      unknownKeys(entry, [
        "contract_subject", "subject_id", "statement", "source_refs", "requirement_ids",
        "acceptance_ids", "depends_on", "rationale", "expected_outcome", "affected_scope",
        "completion_evidence",
      ], rowPath, issues);
      if (!enumValue(entry.contract_subject, ["requirement", "decision", "task"])) issues.push(`${rowPath}.contract_subject is invalid`);
      countString(entry.subject_id, `${rowPath}.subject_id`);
      if (typeof entry.subject_id === "string") {
        if (seenSubjectIds.has(entry.subject_id)) issues.push(`${rowPath}.subject_id must be unique within semantic_rows`);
        seenSubjectIds.add(entry.subject_id);
        rowKinds.set(entry.subject_id, typeof entry.contract_subject === "string" ? entry.contract_subject : "");
      }
      for (const key of ["statement", "rationale", "expected_outcome"] as const) countString(entry[key], `${rowPath}.${key}`);
      for (const key of ["source_refs", "requirement_ids", "acceptance_ids", "depends_on", "affected_scope", "completion_evidence"] as const) {
        const path = `${rowPath}.${key}`;
        const values = entry[key];
        if (!isExactArray(values)) {
          issues.push(`${path} must be a plain array`);
          continue;
        }
        if (values.length > IMPORT_SUPPLEMENT_MAX_NESTED_REFS) issues.push(`${path} exceeds the ${IMPORT_SUPPLEMENT_MAX_NESTED_REFS}-entry bound`);
        const seen = new Set<string>();
        values.forEach((item, itemIndex) => {
          countString(item, `${path}[${itemIndex}]`);
          if (typeof item !== "string") return;
          if (seen.has(item)) issues.push(`${path} must not contain duplicate entries`);
          seen.add(item);
        });
      }
    });
  }
  const sections = value.sections;
  if (!isExactArray(sections) || sections.length === 0) {
    issues.push("$.sections must be a non-empty plain array");
  } else if (sections.length > IMPORT_SUPPLEMENT_MAX_SECTIONS) {
    issues.push(`$.sections exceeds the ${IMPORT_SUPPLEMENT_MAX_SECTIONS}-entry bound`);
  } else {
    sections.forEach((entry, index) => {
      const sectionPath = `$.sections[${index}]`;
      if (!isExactPlainRecord(entry)) {
        issues.push(`${sectionPath} must be a plain JSON object`);
        return;
      }
      unknownKeys(entry, ["title", "missing_or_conflict", "source_refs"], sectionPath, issues);
      countString(entry.title, `${sectionPath}.title`);
      countString(entry.missing_or_conflict, `${sectionPath}.missing_or_conflict`);
      const refs = entry.source_refs;
      if (!isExactArray(refs) || refs.length === 0) {
        issues.push(`${sectionPath}.source_refs must be a non-empty plain array`);
      } else if (refs.length > IMPORT_SUPPLEMENT_MAX_NESTED_REFS) {
        issues.push(`${sectionPath}.source_refs exceeds the ${IMPORT_SUPPLEMENT_MAX_NESTED_REFS}-entry bound`);
      } else {
        const seen = new Set<string>();
        refs.forEach((ref, index) => {
          countString(ref, `${sectionPath}.source_refs[${index}]`);
          if (typeof ref !== "string") return;
          if (seen.has(ref)) issues.push(`${sectionPath}.source_refs must not contain duplicate entries`);
          seen.add(ref);
        });
      }
    });
  }
  if (aggregateBytes > IMPORT_SUPPLEMENT_MAX_AGGREGATE_BYTES) {
    issues.push(`supplement metadata exceeds the ${IMPORT_SUPPLEMENT_MAX_AGGREGATE_BYTES}-byte aggregate bound`);
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function validateCompatibilitySupplementGraph(
  value: unknown,
  options: CompatibilitySupplementGraphOptions = {},
): { ok: true } | { ok: false; issues: string[] } {
  const shape = validateCompatibilitySupplementShape(value);
  if (!shape.ok) return shape;
  const supplement = value as UnknownRecord;
  const rows = supplement.semantic_rows as UnknownRecord[];
  const rowKinds = new Map<string, string>();
  for (const row of rows) {
    if (isExactPlainRecord(row) && typeof row.subject_id === "string" && typeof row.contract_subject === "string") rowKinds.set(row.subject_id, row.contract_subject);
  }
  const requirementIds = new Set(options.requirementIds ?? []);
  const taskIds = new Set(options.taskIds ?? []);
  for (const [id, kind] of rowKinds) {
    if (kind === "requirement") requirementIds.add(id);
    if (kind === "task") taskIds.add(id);
  }
  const issues: string[] = [];
  const authorizedRefs = options.authorizedSourceRefs;
  rows.forEach((row, index) => {
    if (!isExactPlainRecord(row)) return;
    const rowPath = `$.semantic_rows[${index}]`;
    const sourceRefs = row.source_refs as unknown[];
    if (authorizedRefs && sourceRefs.some((ref) => typeof ref !== "string" || !authorizedRefs.has(ref))) issues.push(`${rowPath}.source_refs must cite only authorized source paths`);
    const requirementRefs = row.requirement_ids as unknown[];
    if (requirementRefs.some((ref) => typeof ref !== "string" || !requirementIds.has(ref))) issues.push(`${rowPath}.requirement_ids references an unknown requirement`);
    const dependencies = row.depends_on as unknown[];
    if (dependencies.some((ref) => typeof ref !== "string" || !taskIds.has(ref))) issues.push(`${rowPath}.depends_on references an unknown task`);
    if (typeof row.subject_id === "string" && dependencies.includes(row.subject_id)) issues.push(`${rowPath}.depends_on must not self-reference`);
  });
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function validateCompatibilitySupplement(value: unknown): { ok: true } | { ok: false; issues: string[] } {
  return validateCompatibilitySupplementShape(value);
}
