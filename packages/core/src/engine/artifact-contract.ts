/**
 * Executable artifact contracts.
 *
 * The shipped `workflows/artifacts-schema.json` is declarative only; this
 * module makes it executable with a dependency-free draft-07 subset that
 * covers every keyword the shipped definitions use:
 *
 *   type, required, properties, items, enum, minimum, maximum, minItems,
 *   additionalProperties (boolean | object), description (ignored)
 *
 * Unsupported keywords fail closed with a diagnostic — a schema we cannot
 * fully honor is never partially enforced. Compatibility is additive:
 *
 *   - artifact ids with no schema definition are unconstrained (pass);
 *   - artifact ids may be explicitly grandfathered via
 *     {@link ArtifactContractPolicy.grandfathered} (legacy shapes);
 *   - present-but-invalid produced/consumed artifacts block with
 *     field-level diagnostics;
 *   - a missing consumed artifact blocks only when its producing stage is
 *     `done` (it claimed completion but the artifact is absent); producers
 *     that are pending (loop feedback on the first pass) or skipped are
 *     legitimate absences.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readArtifact } from "./artifacts.js";
import type { Profile, StageDef, TeamState } from "./types.js";

export interface JsonSchemaDef {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaDef>;
  items?: JsonSchemaDef;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  additionalProperties?: boolean | JsonSchemaDef;
  description?: string;
  [keyword: string]: unknown;
}

const SUPPORTED_KEYWORDS = new Set([
  "type", "required", "properties", "items", "enum", "minimum", "maximum",
  "minItems", "additionalProperties", "description", "$schema", "$id", "title",
]);

export interface ArtifactIssue {
  /** JSON-ish path, e.g. `$`, `$.items[0].path`, `$.build_status`. */
  field: string;
  message: string;
}

export type ArtifactValidationResult = { ok: true } | { ok: false; issues: ArtifactIssue[] };

export interface ArtifactContractPolicy {
  /** Validate schema-defined artifacts. Default true. */
  validate: boolean;
  /** Explicitly grandfathered legacy artifact ids (skipped). */
  grandfathered: string[];
}

export const DEFAULT_ARTIFACT_CONTRACT_POLICY: ArtifactContractPolicy = {
  validate: true,
  grandfathered: [],
};

let schemaCache: Record<string, JsonSchemaDef> | null = null;

/** Load `workflows/artifacts-schema.json` definitions (cached). */
export function loadArtifactSchemas(): Record<string, JsonSchemaDef> {
  if (schemaCache) return schemaCache;
  let defs: Record<string, JsonSchemaDef> = {};
  try {
    // Distribution layout: <pkg>/dist/engine/artifact-contract.js -> <pkg>/workflows/
    const here = fileURLToPath(import.meta.url);
    const pkgRoot = resolve(here, "..", "..", "..");
    const path = join(pkgRoot, "workflows", "artifacts-schema.json");
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { definitions?: Record<string, JsonSchemaDef> };
      defs = raw.definitions ?? {};
    }
  } catch {
    defs = {};
  }
  schemaCache = defs;
  return defs;
}

/** Schema definition for an artifact id, or null when unconstrained. */
export function artifactSchemaFor(id: string): JsonSchemaDef | null {
  return loadArtifactSchemas()[id] ?? null;
}

/** Required top-level fields of a schema-defined artifact (null when unconstrained). */
export function requiredFieldsOf(id: string): string[] | null {
  const schema = artifactSchemaFor(id);
  if (!schema) return null;
  return schema.required ?? [];
}

/**
 * Validate a produced artifact value against its contract. Field-level
 * issues are returned; any issue means the artifact is invalid.
 */
export function validateProducedArtifact(
  id: string,
  value: unknown,
  policy: ArtifactContractPolicy = DEFAULT_ARTIFACT_CONTRACT_POLICY,
): ArtifactValidationResult {
  if (!policy.validate) return { ok: true };
  if (policy.grandfathered.includes(id)) return { ok: true };
  const schema = artifactSchemaFor(id);
  if (!schema) return { ok: true };
  const issues: ArtifactIssue[] = [];
  validateValue(schema, value, "$", issues, `artifact '${id}'`);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

export interface ConsumeDiagnostic {
  id: string;
  missing: boolean;
  /** Producer stage status when the artifact is absent (`done` => violation). */
  producer_status: string | null;
  issues: ArtifactIssue[];
}

export type ConsumeValidationResult =
  | { ok: true; diagnostics: ConsumeDiagnostic[] }
  | { ok: false; error: string; diagnostics: ConsumeDiagnostic[] };

/**
 * Validate the artifacts a stage declares in `consumes`. Present artifacts
 * are schema-checked; a missing artifact is a violation only when its
 * producing stage is `done` (the producer claimed completion without the
 * artifact). Pending producers (loop feedback on the first pass) and
 * skipped producers are legitimate absences.
 */
export function validateConsumedArtifacts(
  stage: StageDef,
  artifactsDir: string,
  state: TeamState,
  profile: Profile | null,
  policy: ArtifactContractPolicy = DEFAULT_ARTIFACT_CONTRACT_POLICY,
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
    if (!policy.validate || policy.grandfathered.includes(id)) {
      diagnostics.push({ id, missing: false, producer_status: producerStatus.get(id) ?? null, issues: [] });
      continue;
    }
    const schema = artifactSchemaFor(id);
    if (!schema) {
      diagnostics.push({ id, missing: false, producer_status: producerStatus.get(id) ?? null, issues: [] });
      continue;
    }
    const value = readArtifact(artifactsDir, id);
    if (value === null) {
      const status = producerStatus.get(id) ?? null;
      const missing = status === "done";
      diagnostics.push({
        id,
        missing,
        producer_status: status,
        issues: missing ? [{ field: "$", message: `consumed artifact '${id}.json' is missing while its producing stage is done` }] : [],
      });
      continue;
    }
    const issues: ArtifactIssue[] = [];
    validateValue(schema, value, "$", issues, `artifact '${id}'`);
    diagnostics.push({ id, missing: false, producer_status: producerStatus.get(id) ?? null, issues });
  }
  const blocking = diagnostics.filter((diagnostic) => diagnostic.issues.length > 0);
  if (blocking.length > 0) {
    return { ok: false, error: formatConsumeIssues(blocking), diagnostics };
  }
  return { ok: true, diagnostics };
}

function formatConsumeIssues(diagnostics: ConsumeDiagnostic[]): string {
  const lines = diagnostics.map((diagnostic) => {
    const detail = diagnostic.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
    return `${diagnostic.id}: ${detail}`;
  });
  return `consumed artifact contract violation(s): ${lines.join(" | ")}`;
}

function producesOf(stage: StageDef): string[] {
  return Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
}

function validateValue(
  schema: JsonSchemaDef,
  value: unknown,
  path: string,
  issues: ArtifactIssue[],
  where: string,
): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      issues.push({ field: path, message: `${where}: unsupported schema keyword '${keyword}' — refusing partial validation` });
      return;
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      issues.push({ field: path, message: `${where}: expected type ${types.join("|")}, got ${describeValue(value)}` });
      return;
    }
  }
  if (schema.enum !== undefined) {
    if (!schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
      issues.push({ field: path, message: `${where}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}` });
      return;
    }
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    issues.push({ field: path, message: `${where}: ${value} is below minimum ${schema.minimum}` });
  }
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
    issues.push({ field: path, message: `${where}: ${value} is above maximum ${schema.maximum}` });
  }
  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) {
    issues.push({ field: path, message: `${where}: array has ${value.length} items, minimum is ${schema.minItems}` });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateValue(schema.items!, item, `${path}[${index}]`, issues, where));
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) {
        issues.push({ field: `${path}.${required}`, message: `${where}: required field '${required}' is missing` });
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        validateValue(child, record[key], `${path}.${key}`, issues, where);
      }
    }
    const additional = schema.additionalProperties;
    if (additional === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!known.has(key)) issues.push({ field: `${path}.${key}`, message: `${where}: unknown field '${key}' is not allowed` });
      }
    } else if (additional && typeof additional === "object") {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, child] of Object.entries(record)) {
        if (!known.has(key)) validateValue(additional, child, `${path}.${key}`, issues, where);
      }
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
