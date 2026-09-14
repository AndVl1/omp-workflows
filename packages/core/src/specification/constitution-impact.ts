/**
 * Semantic constitution impact assessment (T021).
 *
 * Assessments are deterministic over the exact policy fingerprints and the
 * complete approved-artifact inventory. A passing result is authoritative
 * only after this module has persisted and re-read it from the project-scoped
 * evidence directory. Consumers must use `loadConstitutionImpactEvidence`
 * rather than trusting a caller-provided object.
 */
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PinnedProjectRoot, PinnedRootError, rollbackPinnedRootWriteReceipt, type PinnedRootWriteReceipt } from "./pinned-root.js";
import type {
  ConstitutionArtifactImpactResult,
  ConstitutionBinding,
  ConstitutionImpactAssessment,
} from "./types.js";
import {
  canonicalJson,
  digestOf,
  validateConstitutionBinding,
} from "./validation.js";

/** Versioned evaluator identity recorded in every assessment. */
export const IMPACT_EVALUATOR_VERSION = "constitution-impact@2";
const IMPACT_SCHEMA_VERSION = 1 as const;
const IMPACT_FILE_RE = /^constitution-impact-([a-f0-9]{64})$/;

function currentImpactSourceMatches(pinnedRoot: PinnedProjectRoot, binding: ConstitutionBinding): { ok: true } | { ok: false; error: string } {
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before constitution impact source check" };
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(binding.path, { maxBytes: MAX_EVIDENCE_BYTES }).bytes,
    );
    const contentSha = createHash("sha256").update(content).digest("hex");
    if (contentSha !== binding.content_sha256) return { ok: false, error: "current constitution bytes do not match the assessment binding" };
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while checking constitution impact source" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `current constitution source is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_IMPACT_ARTIFACTS = 4096;
const MAX_IMPACT_SECTIONS_PER_ARTIFACT = 256;
const MAX_IMPACT_DEPENDENCIES_PER_ARTIFACT = 256;
const MAX_IMPACT_IDENTIFIER_BYTES = 256;
const MAX_IMPACT_INPUT_BYTES = MAX_EVIDENCE_BYTES;
const IMPACT_EVIDENCE_DIR = join(".work-state", "specification", "constitution");

/**
 * Canonical constitution-governed topic sections. An artifact's semantic
 * sections whose ids fall into this vocabulary are constitution-derived; a
 * semantic policy change directly affects them, and the dependency closure
 * propagates staleness to their dependants.
 */
export const CONSTITUTION_TOPIC_SECTIONS: readonly string[] = Object.freeze([
  "principles",
  "quality",
  "security",
  "governance",
  "compliance",
  "ownership",
  "verification",
  "workflow",
  "state",
  "dispatch",
  "compatibility",
  "runtime",
  "fail-closed",
  "scope",
]);

export interface ApprovedArtifactImpactInput {
  artifact_id: string;
  /** Stable section id → SHA-256 evidence captured at approval time. */
  semantic_section_hashes: Record<string, string>;
  /** Upstream artifact ids this artifact depends on. */
  depends_on: string[];
}

/** Exact durable shape returned by the evaluator and accepted by the gate. */
export interface ConstitutionImpactResult extends ConstitutionImpactAssessment {
  schema_version: 1;
  status: "pass";
  assessment_hash: string;
  project_root_hash: string;
  previous_binding_hash: string;
  current_binding_hash: string;
  /** Feature/run selector and exact canonical approved inventory provenance. */
  feature_id?: string;
  run_key?: string;
  inventory_digest?: string;
  approved_artifacts_hash: string;
  /** Complete canonical inventory used to derive every verdict. */
  approved_artifacts: ApprovedArtifactImpactInput[];
}

export type ConstitutionImpactCode =
  | "SPEC_BINDING_INVALID"
  | "SPEC_IMPACT_GRAPH_INVALID"
  | "SPEC_CONSTITUTION_IMPACT_PENDING"
  | "SPEC_PATH_UNAUTHORIZED"
  | "SPEC_IMPACT_EVIDENCE_INVALID";

export type ConstitutionImpactOutcome =
  | { ok: true; value: ConstitutionImpactResult }
  | { ok: false; code: ConstitutionImpactCode; error: string };

function isHexSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}


function bindingEvidence(binding: ConstitutionBinding): Omit<ConstitutionBinding, "bound_at"> {
  return {
    provider_id: binding.provider_id,
    path: binding.path,
    version: binding.version,
    content_sha256: binding.content_sha256,
    semantic_hash: binding.semantic_hash,
    validation_ref: binding.validation_ref,
  };
}

function bindingHash(binding: ConstitutionBinding): string {
  return digestOf(bindingEvidence(binding));
}

function bindingEvidenceMatches(expected: ConstitutionBinding, actual: ConstitutionBinding): boolean {
  return canonicalJson(bindingEvidence(expected)) === canonicalJson(bindingEvidence(actual));
}

function normalizeArtifacts(
  artifacts: readonly ApprovedArtifactImpactInput[],
): ApprovedArtifactImpactInput[] {
  return artifacts.map((artifact) => ({
    artifact_id: artifact.artifact_id,
    semantic_section_hashes: Object.fromEntries(
      Object.entries(artifact.semantic_section_hashes)
        .map(([key, hash]) => [key.trim().toLowerCase(), hash] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    depends_on: [...artifact.depends_on].sort(),
  })).sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

/**
 * Forward dependency closure: the artifact plus every transitive dependant
 * (artifacts whose `depends_on` chains reach it). Deterministic order.
 */
export function dependencyClosure(
  artifactId: string,
  artifacts: readonly ApprovedArtifactImpactInput[],
): string[] {
  const dependants = new Map<string, string[]>();
  for (const artifact of artifacts) {
    for (const upstream of artifact.depends_on) {
      const list = dependants.get(upstream) ?? [];
      list.push(artifact.artifact_id);
      dependants.set(upstream, list);
    }
  }
  for (const list of dependants.values()) list.sort();

  // Discover only forward-reachable artifacts; unrelated branches remain out
  // of the closure even when they sort before the directly affected artifact.
  const closure = new Set<string>([artifactId]);
  const queue = [artifactId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of dependants.get(current) ?? []) {
      if (!closure.has(next)) {
        closure.add(next);
        queue.push(next);
      }
    }
  }

  // Kahn algorithm emits the directly affected artifact first, then each
  // dependant only after its in-closure dependencies. A cycle cannot be
  // ordered, so fail closed instead of returning a misleading partial list.
  const inDegree = new Map<string, number>();
  for (const id of closure) {
    const artifact = artifacts.find((candidate) => candidate.artifact_id === id);
    inDegree.set(id, artifact?.depends_on.filter((upstream) => closure.has(upstream)).length ?? 0);
  }
  const ordered = [artifactId];
  const emitted = new Set<string>([artifactId]);
  const ready: string[] = [];
  const enqueueReady = (id: string): void => {
    if (!emitted.has(id) && !ready.includes(id) && inDegree.get(id) === 0) ready.push(id);
    ready.sort();
  };
  for (const next of dependants.get(artifactId) ?? []) {
    const degree = inDegree.get(next);
    if (degree !== undefined) inDegree.set(next, degree - 1);
    enqueueReady(next);
  }
  while (ready.length > 0) {
    const current = ready.shift()!;
    if (emitted.has(current)) continue;
    emitted.add(current);
    ordered.push(current);
    for (const next of dependants.get(current) ?? []) {
      if (!closure.has(next)) continue;
      const degree = inDegree.get(next);
      if (degree === undefined) continue;
      inDegree.set(next, degree - 1);
      enqueueReady(next);
    }
  }
  if (ordered.length !== closure.size) {
    throw new Error("dependency graph contains a cycle involving " + artifactId);
  }
  return ordered;
}

function validateInputs(
  previous: ConstitutionBinding,
  current: ConstitutionBinding,
  artifacts: readonly ApprovedArtifactImpactInput[],
): { code: ConstitutionImpactCode; error: string } | null {
  const previousIssues = validateConstitutionBinding(previous);
  if (previousIssues.length > 0) {
    return { code: "SPEC_BINDING_INVALID", error: `previous binding invalid: ${previousIssues.join("; ")}` };
  }
  if (artifacts.length > MAX_IMPACT_ARTIFACTS) {
    return {
      code: "SPEC_IMPACT_GRAPH_INVALID",
      error: `approved_artifacts exceeds the ${MAX_IMPACT_ARTIFACTS}-entry limit`,
    };
  }
  let aggregateBytes: number;
  try {
    aggregateBytes = Buffer.byteLength(JSON.stringify(artifacts), "utf8");
  } catch {
    return { code: "SPEC_IMPACT_GRAPH_INVALID", error: "approved_artifacts must be JSON-serializable" };
  }
  if (aggregateBytes > MAX_IMPACT_INPUT_BYTES) {
    return {
      code: "SPEC_IMPACT_GRAPH_INVALID",
      error: `approved_artifacts exceeds the ${MAX_IMPACT_INPUT_BYTES}-byte UTF-8 limit`,
    };
  }

  const currentIssues = validateConstitutionBinding(current);
  if (currentIssues.length > 0) {
    return { code: "SPEC_BINDING_INVALID", error: `current binding invalid: ${currentIssues.join("; ")}` };
  }

  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.artifact_id !== "string" || artifact.artifact_id.trim().length === 0) {
      return { code: "SPEC_IMPACT_GRAPH_INVALID", error: "every approved artifact needs a non-empty artifact_id" };
    }
    if (Buffer.byteLength(artifact.artifact_id, "utf8") > MAX_IMPACT_IDENTIFIER_BYTES) {
      return {
        code: "SPEC_IMPACT_GRAPH_INVALID",
        error: `artifact '${artifact.artifact_id}' exceeds the ${MAX_IMPACT_IDENTIFIER_BYTES}-byte identifier limit`,
      };
    }
    if (ids.has(artifact.artifact_id)) {
      return { code: "SPEC_IMPACT_GRAPH_INVALID", error: `duplicate artifact id: ${artifact.artifact_id}` };
    }
    ids.add(artifact.artifact_id);
    if (!artifact.semantic_section_hashes || typeof artifact.semantic_section_hashes !== "object"
      || Array.isArray(artifact.semantic_section_hashes)) {
      return { code: "SPEC_IMPACT_GRAPH_INVALID", error: `artifact '${artifact.artifact_id}' needs a semantic_section_hashes record` };
    }
    const sectionEntries = Object.entries(artifact.semantic_section_hashes);
    if (sectionEntries.length > MAX_IMPACT_SECTIONS_PER_ARTIFACT) {
      return {
        code: "SPEC_IMPACT_GRAPH_INVALID",
        error: `artifact '${artifact.artifact_id}' exceeds the ${MAX_IMPACT_SECTIONS_PER_ARTIFACT}-section limit`,
      };
    }
    if (sectionEntries.some(([rawSection]) => Buffer.byteLength(rawSection, "utf8") > MAX_IMPACT_IDENTIFIER_BYTES)) {
      return {
        code: "SPEC_IMPACT_GRAPH_INVALID",
        error: `artifact '${artifact.artifact_id}' has an oversized semantic section identifier`,
      };
    }
    const sectionIds = new Set<string>();
    for (const [rawSection, hash] of Object.entries(artifact.semantic_section_hashes)) {
      const section = rawSection.trim().toLowerCase();
      if (section.length === 0 || sectionIds.has(section) || !isHexSha256(hash)) {
        return { code: "SPEC_IMPACT_GRAPH_INVALID", error: `artifact '${artifact.artifact_id}' has invalid or duplicate semantic section evidence` };
      }
      sectionIds.add(section);
    }
    if (Array.isArray(artifact.depends_on) && artifact.depends_on.length > MAX_IMPACT_DEPENDENCIES_PER_ARTIFACT) {
      return {
        code: "SPEC_IMPACT_GRAPH_INVALID",
        error: `artifact '${artifact.artifact_id}' exceeds the ${MAX_IMPACT_DEPENDENCIES_PER_ARTIFACT}-dependency limit`,
      };
    }
    if (Array.isArray(artifact.depends_on)
      && artifact.depends_on.some((id) => typeof id === "string" && Buffer.byteLength(id, "utf8") > MAX_IMPACT_IDENTIFIER_BYTES)) {
      return {
        code: "SPEC_IMPACT_GRAPH_INVALID",
        error: `artifact '${artifact.artifact_id}' has an oversized dependency identifier`,
      };
    }
    if (!Array.isArray(artifact.depends_on)
      || artifact.depends_on.some((id) => typeof id !== "string" || id.trim().length === 0)
      || new Set(artifact.depends_on).size !== artifact.depends_on.length
      || artifact.depends_on.includes(artifact.artifact_id)) {
      return { code: "SPEC_IMPACT_GRAPH_INVALID", error: `artifact '${artifact.artifact_id}' has invalid dependencies` };
    }
  }
  for (const artifact of artifacts) {
    for (const upstream of artifact.depends_on) {
      if (!ids.has(upstream)) {
        return { code: "SPEC_IMPACT_GRAPH_INVALID", error: `artifact '${artifact.artifact_id}' depends on unknown artifact '${upstream}'` };
      }
    }
  }

  const state = new Map<string, 1 | 2>();
  const byId = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const visit = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === 1) return false;
    if (mark === 2) return true;
    state.set(id, 1);
    for (const upstream of byId.get(id)!.depends_on) {
      if (!visit(upstream)) return false;
    }
    state.set(id, 2);
    return true;
  };
  for (const artifact of artifacts) {
    if (!visit(artifact.artifact_id)) {
      return { code: "SPEC_IMPACT_GRAPH_INVALID", error: `dependency graph contains a cycle at '${artifact.artifact_id}'` };
    }
  }
  return null;
}

function sectionKeys(artifact: ApprovedArtifactImpactInput): string[] {
  return Object.keys(artifact.semantic_section_hashes).sort();
}

function evaluateRows(
  previous: ConstitutionBinding,
  current: ConstitutionBinding,
  artifacts: readonly ApprovedArtifactImpactInput[],
): { rows: ConstitutionArtifactImpactResult[]; blocked: string | null } {
  const contentUnchanged = previous.content_sha256 === current.content_sha256;
  const semanticsUnchanged = previous.semantic_hash === current.semantic_hash;
  const rows: ConstitutionArtifactImpactResult[] = [];

  if (contentUnchanged || semanticsUnchanged) {
    for (const artifact of artifacts) {
      const sections = sectionKeys(artifact);
      if (!contentUnchanged && sections.length === 0) {
        return { rows: [], blocked: `artifact '${artifact.artifact_id}' carries no semantic section evidence; equivalence cannot be proven` };
      }
      rows.push({
        artifact_id: artifact.artifact_id,
        verdict: "no_impact",
        evidence_refs: contentUnchanged
          ? [`content_sha256:${current.content_sha256}`]
          : [`semantic_hash:${previous.semantic_hash}`, `sections:${sections.join(",")}`],
      });
    }
    return { rows, blocked: null };
  }

  for (const artifact of artifacts) {
    if (sectionKeys(artifact).length === 0) {
      return { rows: [], blocked: `artifact '${artifact.artifact_id}' carries no semantic section evidence; impact cannot be proven` };
    }
  }
  const governed = new Map<string, string[]>();
  for (const artifact of artifacts) {
    const matched = sectionKeys(artifact).filter((key) => CONSTITUTION_TOPIC_SECTIONS.includes(key));
    if (matched.length > 0) governed.set(artifact.artifact_id, matched);
  }
  const affected = new Set<string>(governed.keys());
  for (const id of governed.keys()) {
    for (const reached of dependencyClosure(id, artifacts)) affected.add(reached);
  }
  for (const artifact of artifacts) {
    if (affected.has(artifact.artifact_id)) {
      const evidence = (governed.get(artifact.artifact_id) ?? []).map((section) => `section:${section}`);
      for (const root of governed.keys()) {
        if (root !== artifact.artifact_id && dependencyClosure(root, artifacts).includes(artifact.artifact_id)) {
          evidence.push(`dependency_of:${root}`);
        }
      }
      rows.push({
        artifact_id: artifact.artifact_id,
        verdict: "affected",
        evidence_refs: evidence.length > 0 ? evidence.sort() : ["semantic_change_scoped"],
      });
    } else {
      rows.push({
        artifact_id: artifact.artifact_id,
        verdict: "no_impact",
        evidence_refs: [`sections:${sectionKeys(artifact).join(",")}`, "constitution_topics_absent"],
      });
    }
  }
  return { rows, blocked: null };
}

function assessmentHashOf(
  value: Omit<ConstitutionImpactResult, "assessment_id" | "assessment_hash" | "assessed_at">,
): string {
  const { previous_binding: previous, current_binding: current, ...stable } = value;
  return digestOf({
    ...stable,
    previous_binding: bindingEvidence(previous),
    current_binding: bindingEvidence(current),
  });
}

function strictKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return canonicalJson(keys) === canonicalJson([...expected].sort());
}

function validatePersistedEvidence(
  value: unknown,
  projectRoot: string,
): value is ConstitutionImpactResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const baseFields = [
    "schema_version", "assessment_id", "assessment_hash", "project_root_hash",
    "previous_binding_hash", "current_binding_hash", "approved_artifacts_hash",
    "previous_binding", "current_binding", "approved_artifacts", "evaluator_version",
    "artifact_results", "status", "assessed_at",
  ] as const;
  const identityFields = ["feature_id", "run_key", "inventory_digest"] as const;
  const hasIdentity = record.feature_id !== undefined || record.run_key !== undefined || record.inventory_digest !== undefined;
  if (!strictKeys(record, hasIdentity ? [...baseFields, ...identityFields] : baseFields)) return false;
  if (record.schema_version !== IMPACT_SCHEMA_VERSION || record.evaluator_version !== IMPACT_EVALUATOR_VERSION
    || record.status !== "pass" || !IMPACT_FILE_RE.test(String(record.assessment_id))
    || !isHexSha256(record.assessment_hash) || !isHexSha256(record.project_root_hash)
    || !isHexSha256(record.previous_binding_hash) || !isHexSha256(record.current_binding_hash)
    || !isHexSha256(record.approved_artifacts_hash)
    || typeof record.assessed_at !== "string" || !Number.isFinite(Date.parse(record.assessed_at))) return false;
  if (hasIdentity && (
    typeof record.feature_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(record.feature_id)
    || typeof record.run_key !== "string" || record.run_key.trim().length === 0
    || !isHexSha256(record.inventory_digest)
  )) return false;
  if (validateConstitutionBinding(record.previous_binding).length > 0
    || validateConstitutionBinding(record.current_binding).length > 0
    || !Array.isArray(record.approved_artifacts)
    || !Array.isArray(record.artifact_results)) return false;
  const invalid = validateInputs(
    record.previous_binding as ConstitutionBinding,
    record.current_binding as ConstitutionBinding,
    record.approved_artifacts as ApprovedArtifactImpactInput[],
  );
  if (invalid) return false;
  const normalized = normalizeArtifacts(record.approved_artifacts as ApprovedArtifactImpactInput[]);
  if (canonicalJson(normalized) !== canonicalJson(record.approved_artifacts)) return false;
  const evaluated = evaluateRows(
    record.previous_binding as ConstitutionBinding,
    record.current_binding as ConstitutionBinding,
    normalized,
  );
  if (evaluated.blocked || canonicalJson(evaluated.rows) !== canonicalJson(record.artifact_results)) return false;
  if (record.project_root_hash !== digestOf(projectRoot)
    || record.previous_binding_hash !== bindingHash(record.previous_binding as ConstitutionBinding)
    || record.current_binding_hash !== bindingHash(record.current_binding as ConstitutionBinding)
    || record.approved_artifacts_hash !== digestOf(normalized)
    || (hasIdentity && record.inventory_digest !== digestOf(normalized))) return false;
  const { assessment_id: _id, assessment_hash: _hash, assessed_at: _at, ...payload } = record;
  const expectedHash = assessmentHashOf(payload as Omit<ConstitutionImpactResult, "assessment_id" | "assessment_hash" | "assessed_at">);
  return record.assessment_hash === expectedHash
    && record.assessment_id === `constitution-impact-${expectedHash}`;

}
function evidencePath(dir: string, assessmentId: string): string | null {
  const match = IMPACT_FILE_RE.exec(assessmentId);
  return match ? join(dir, `impact-${match[1]}.json`) : null;
}

function readPersistedEvidence(
  projectRoot: string,
  assessmentId: string,
  providedRoot?: PinnedProjectRoot,
): ConstitutionImpactResult | null {
  const ownsPinnedRoot = providedRoot === undefined;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return null;
  try {
    if (!pinnedRoot.isStable()) return null;
    const relativePath = evidencePath(IMPACT_EVIDENCE_DIR, assessmentId);
    if (!relativePath || !pinnedRoot.pathEntryExists(relativePath)) return null;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(relativePath, { maxBytes: MAX_EVIDENCE_BYTES }).bytes,
    );
    const parsed: unknown = JSON.parse(raw);
    if (!pinnedRoot.isStable()) return null;
    return validatePersistedEvidence(parsed, pinnedRoot.canonical_root) ? parsed : null;
  } catch {
    return null;
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}
type SerializedImpactEvidence =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string };

function serializeImpactEvidence(value: ConstitutionImpactResult): SerializedImpactEvidence {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    return {
      ok: false,
      error: `constitution impact evidence could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const bytes = Buffer.from(serialized, "utf8");
  return bytes.byteLength <= MAX_EVIDENCE_BYTES
    ? { ok: true, bytes }
    : { ok: false, error: `constitution impact evidence exceeds the ${MAX_EVIDENCE_BYTES}-byte limit` };
}


/**
 * Load and verify engine-produced durable evidence. The caller object is only
 * an asserted copy: it must exactly equal the canonical file, whose hashes,
 * independently revalidated.
 */
export function loadConstitutionImpactEvidence(
  projectRoot: string,
  candidate: ConstitutionImpactResult,
  previous: ConstitutionBinding,
  current: ConstitutionBinding,
  providedRoot?: PinnedProjectRoot,
): ConstitutionImpactResult | null {
  if (!candidate || typeof candidate.assessment_id !== "string") return null;
  const persisted = readPersistedEvidence(projectRoot, candidate.assessment_id, providedRoot);
  if (!persisted || canonicalJson(candidate) !== canonicalJson(persisted)) return null;
  if (!bindingEvidenceMatches(previous, persisted.previous_binding)
    || !bindingEvidenceMatches(current, persisted.current_binding)) return null;
  return persisted;
}

/** Read an engine-produced assessment by its content-addressed id. */
export function readConstitutionImpactEvidence(
  projectRoot: string,
  assessmentId: string,
  providedRoot?: PinnedProjectRoot,
): ConstitutionImpactResult | null {
  return readPersistedEvidence(projectRoot, assessmentId, providedRoot);
}


/**
 * Assess and durably persist semantic impact over the complete approved set.
 * A positive result is returned only after the evidence was safely re-read.
 */
export function assessConstitutionImpact(
  projectRoot: string,
  input: {
    previous_binding: ConstitutionBinding;
    current_binding: ConstitutionBinding;
    approved_artifacts: ApprovedArtifactImpactInput[];
    feature_id?: string;
    run_key?: string;
  },
  providedRoot?: PinnedProjectRoot,
): ConstitutionImpactOutcome {
  if (!Array.isArray(input.approved_artifacts)) {
    return { ok: false, code: "SPEC_IMPACT_GRAPH_INVALID", error: "approved_artifacts must be an array" };
  }
  const invalid = validateInputs(input.previous_binding, input.current_binding, input.approved_artifacts);
  if ((input.feature_id === undefined) !== (input.run_key === undefined)
    || (input.feature_id !== undefined && (typeof input.feature_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.feature_id)))
    || (input.run_key !== undefined && (typeof input.run_key !== "string"
      || input.run_key.trim().length === 0
      || Buffer.byteLength(input.run_key, "utf8") > MAX_IMPACT_IDENTIFIER_BYTES))) {
    return { ok: false, code: "SPEC_IMPACT_GRAPH_INVALID", error: "feature_id and run_key must be provided together and be valid" };
  }
  if (invalid) return { ok: false, ...invalid };
  const ownsPinnedRoot = providedRoot === undefined;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root is not a readable directory" };
  }
  try {
    if (!pinnedRoot.isStable()) {
      return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before constitution impact assessment" };
    }
    const root = pinnedRoot.canonical_root;
    const artifacts = normalizeArtifacts(input.approved_artifacts);
    const evaluated = evaluateRows(input.previous_binding, input.current_binding, artifacts);
    if (evaluated.blocked) {
      return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: evaluated.blocked };
    }

    const base = {
      schema_version: IMPACT_SCHEMA_VERSION,
      project_root_hash: digestOf(root),
      previous_binding_hash: bindingHash(input.previous_binding),
      current_binding_hash: bindingHash(input.current_binding),
      approved_artifacts_hash: digestOf(artifacts),
      ...(input.feature_id !== undefined && input.run_key !== undefined
        ? { feature_id: input.feature_id, run_key: input.run_key, inventory_digest: digestOf(artifacts) }
        : {}),
      previous_binding: input.previous_binding,
      current_binding: input.current_binding,
      approved_artifacts: artifacts,
      evaluator_version: IMPACT_EVALUATOR_VERSION,
      artifact_results: evaluated.rows,
      status: "pass" as const,
    };
    const assessmentHash = assessmentHashOf(base);
    const assessmentId = `constitution-impact-${assessmentHash}`;
    const existing = readPersistedEvidence(root, assessmentId, pinnedRoot);
    if (existing) return { ok: true, value: existing };
    const value: ConstitutionImpactResult = {
      ...base,
      assessment_id: assessmentId,
      assessment_hash: assessmentHash,
      assessed_at: new Date().toISOString(),
    };
    const serialized = serializeImpactEvidence(value);
    if (!serialized.ok) {
      return { ok: false, code: "SPEC_IMPACT_EVIDENCE_INVALID", error: serialized.error };
    }
    let evidenceReceipt: PinnedRootWriteReceipt | undefined;
    try {
      const beforeWrite = input.feature_id === undefined
        ? { ok: true as const }
        : currentImpactSourceMatches(pinnedRoot, input.current_binding);
      if (!beforeWrite.ok) return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: `current constitution source changed before impact evidence persistence: ${beforeWrite.error}` };
      pinnedRoot.ensureDirectory(IMPACT_EVIDENCE_DIR);
      const relativePath = evidencePath(IMPACT_EVIDENCE_DIR, assessmentId)!;
      if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during constitution impact evidence persistence" };
      if (pinnedRoot.pathEntryExists(relativePath)) {
        return { ok: false, code: "SPEC_IMPACT_EVIDENCE_INVALID", error: "existing constitution impact evidence is not a valid engine assessment" };
      }
      evidenceReceipt = pinnedRoot.writeExclusiveWithReceipt(relativePath, serialized.bytes);
      const afterWrite = input.feature_id === undefined
        ? { ok: true as const }
        : currentImpactSourceMatches(pinnedRoot, input.current_binding);
      if (!afterWrite.ok) {
        if (evidenceReceipt) rollbackPinnedRootWriteReceipt(pinnedRoot, evidenceReceipt);
        return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: `current constitution source changed after impact evidence persistence: ${afterWrite.error}` };
      }
    } catch (error) {
      if (error instanceof PinnedRootError && (error.code === "changed" || error.code === "path_unauthorized")) {
        return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during constitution impact evidence persistence" };
      }
      if (error instanceof PinnedRootError && error.code === "exists") {
        const replay = readPersistedEvidence(root, assessmentId, pinnedRoot);
        if (replay) return { ok: true, value: replay };
      }
      return {
        ok: false,
        code: "SPEC_IMPACT_EVIDENCE_INVALID",
        error: `constitution impact evidence could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const persisted = readPersistedEvidence(root, assessmentId, pinnedRoot);
    if (!persisted || canonicalJson(persisted) !== canonicalJson(value) || !pinnedRoot.isStable()) {
      if (evidenceReceipt) rollbackPinnedRootWriteReceipt(pinnedRoot, evidenceReceipt);
      return { ok: false, code: "SPEC_IMPACT_EVIDENCE_INVALID", error: "constitution impact evidence failed durable verification" };
    }
    return { ok: true, value: persisted };
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}
