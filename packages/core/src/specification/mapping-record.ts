import { TextDecoder } from "node:util";
import { PinnedProjectRoot } from "./pinned-root.js";
import { digestOf, isSafeFeatureId, isSafeRelativePath, isSha256Hex, sha256Hex, MAX_HANDOFF_ARRAY_ITEMS } from "./validation.js";
import { isSafeCtoExecutionId, isSafeCtoRunId } from "../cto/state.js";
import {
  MAX_CTO_SPECIFICATION_ID_BYTES,
  MAX_CTO_SPECIFICATION_REQUESTS,
  MAX_CTO_SPECIFICATION_SCOPE_ENTRIES,
  MAX_CTO_SPECIFICATION_TEXT_BYTES,
} from "../cto/types.js";

/** Authoritative producer/parser limits for one durable CTO mapping record. */
export const MAX_CTO_MAPPING_FEATURES = MAX_CTO_SPECIFICATION_REQUESTS;
export const MAX_CTO_MAPPING_TASKS = MAX_HANDOFF_ARRAY_ITEMS;
export const MAX_CTO_MAPPING_CONTRACTS = MAX_HANDOFF_ARRAY_ITEMS;
export const MAX_CTO_MAPPING_PARALLELIZATION = MAX_HANDOFF_ARRAY_ITEMS;
export const MAX_CTO_MAPPING_ARTIFACT_VERSIONS = MAX_HANDOFF_ARRAY_ITEMS;

export const MAX_CTO_MAPPING_RECORD_BYTES = 1024 * 1024;
export const MAX_CTO_MAPPING_LARGE_FIELD_BYTES = MAX_CTO_MAPPING_RECORD_BYTES / 4;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 1_048_576;
const MAX_JSON_KEYS = 128;
const MAX_JSON_ARRAY = MAX_HANDOFF_ARRAY_ITEMS;
const MAX_TASKS = MAX_CTO_MAPPING_TASKS;
const MAX_MAPPING_FEEDBACK_BYTES = 8192;

const RECORD_REQUIRED = new Set(["schema_version", "cto_run_id", "mapping", "selections", "checkpoint_ref", "trusted_answer_ref"]);
const RECORD_OPTIONAL = new Set(["review", "confirmation_context", "confirmed_at", "confirmation_state_after_digest", "confirmation_proof_ref"]);
const MAPPING_REQUIRED = new Set([
  "schema_version", "mapping_id", "mapping_version", "mapping_hash", "feature_ids", "selections",
  "execution_choice", "handoff_bindings", "task_to_slice", "shared_contracts", "parallelization",
  "checkpoint_ref", "status", "created_at",
]);
const MAPPING_OPTIONAL = new Set(["updated_at", "cto_run_id", "execution"]);
const SELECTION_KEYS = new Set(["feature_id", "run_key"]);
const BINDING_KEYS = new Set(["feature_id", "handoff_id", "handoff_digest", "artifact_versions"]);
const ARTIFACT_KEYS = new Set(["artifact_id", "kind", "version", "sha256"]);
const TASK_KEYS = new Set(["feature_id", "task_id", "team_id", "slice_id", "requirement_ids", "verification_ids", "evidence_refs", "depends_on"]);
const CONTRACT_KEYS = new Set(["contract_id", "contract", "owner", "task_ids", "order", "reason", "requires_serialization"]);
const PARALLEL_KEYS = new Set(["slice_id", "decision", "reason", "worktree", "depends_on_slice_ids", "shared_contract_ids"]);
const EXECUTION_KEYS = new Set(["choice", "wave_id", "source_id", "capability_id", "capability_epoch"]);
const REVIEW_KEYS = new Set(["feature_id", "run_key", "stage_id", "decision", "checkpoint_ref", "trusted_answer_ref", "capability_id", "capability_epoch", "policy_hash"]);
const REVIEW_OPTIONAL = new Set(["feedback"]);
const CONFIRMATION_KEYS = new Set(["feature_id", "run_key", "stage_id", "decision", "capability_id", "capability_epoch", "policy_hash"]);

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value: unknown, required: ReadonlySet<string>, optional = new Set<string>()): value is Record<string, unknown> {
  return plain(value)
    && Object.keys(value).every((key) => required.has(key) || optional.has(key))
    && [...required].every((key) => Object.hasOwn(value, key));
}

function bounded(value: unknown, depth: number, budget: { nodes: number }): boolean {
  if (++budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= MAX_CTO_MAPPING_LARGE_FIELD_BYTES;
  if (Array.isArray(value)) return value.length <= MAX_JSON_ARRAY && value.every((item) => bounded(item, depth + 1, budget));
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= MAX_JSON_KEYS
    && keys.every((key) => Buffer.byteLength(key, "utf8") <= MAX_CTO_SPECIFICATION_TEXT_BYTES)
    && keys.every((key) => bounded(value[key], depth + 1, budget));
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_CTO_SPECIFICATION_ID_BYTES
    && /^[A-Za-z0-9._-]+$/u.test(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_CTO_SPECIFICATION_TEXT_BYTES;
}
function largeText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_CTO_MAPPING_LARGE_FIELD_BYTES;
}
function canonicalTaskIdentity(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_CTO_SPECIFICATION_TEXT_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return exact(parsed, new Set(["feature_id", "task_id"]))
      && isSafeFeatureId(parsed.feature_id)
      && text(parsed.task_id)
      && JSON.stringify({ feature_id: parsed.feature_id, task_id: parsed.task_id }) === value;
  } catch {
    return false;
  }
}
function strings(value: unknown, max: number, predicate: (item: unknown) => item is string = safeId): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(predicate);
}

function mappingHashBody(mapping: Record<string, unknown>): Record<string, unknown> {
  const { mapping_id: _id, mapping_hash: _hash, created_at: _created, updated_at: _updated, ...body } = mapping;
  return { ...body, checkpoint_ref: null, status: "awaiting_confirmation" };
}

/** Validate one durable mapping record before any conformance, repair, claim, or dispatch loops. */
export function validateCtoMappingRecord(parsed: unknown, ctoRunId: string, mappingId: string): string | null {
  if (!bounded(parsed, 0, { nodes: 0 })) return "mapping record exceeds JSON work/depth/text bounds";
  if (!exact(parsed, RECORD_REQUIRED, RECORD_OPTIONAL)) return "mapping record has unknown or missing fields";
  const record = parsed;
  if (record.schema_version !== 1 || record.cto_run_id !== ctoRunId || !isSafeCtoRunId(record.cto_run_id)
    || !Array.isArray(record.selections) || record.selections.length === 0 || record.selections.length > MAX_CTO_MAPPING_FEATURES
    || (record.checkpoint_ref !== null && !text(record.checkpoint_ref))
    || (record.trusted_answer_ref !== null && !text(record.trusted_answer_ref))) return "mapping record envelope is invalid or exceeds selector bounds";
  const selections = record.selections as unknown[];
  const features = new Set<string>();
  for (const selection of selections) {
    if (!exact(selection, SELECTION_KEYS) || !isSafeFeatureId(selection.feature_id) || !safeId(selection.run_key)) return "mapping record contains an invalid selector";
    if (features.has(selection.feature_id)) return "mapping record contains duplicate feature selectors";
    features.add(selection.feature_id);
  }
  if (record.review !== undefined && (!exact(record.review, REVIEW_KEYS, REVIEW_OPTIONAL) || (record.review.feedback !== undefined && (typeof record.review.feedback !== "string" || record.review.feedback.length === 0 || record.review.feedback !== record.review.feedback.trim() || Buffer.byteLength(record.review.feedback, "utf8") > MAX_MAPPING_FEEDBACK_BYTES || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(record.review.feedback))))) return "mapping review has unknown or invalid feedback fields";
  if (record.confirmation_context !== undefined && !exact(record.confirmation_context, CONFIRMATION_KEYS)) return "mapping confirmation context has unknown or missing fields";
  if (record.confirmed_at !== undefined && !text(record.confirmed_at)) return "mapping confirmed_at is invalid";
  if (record.confirmation_state_after_digest !== undefined && !isSha256Hex(record.confirmation_state_after_digest)) return "mapping confirmation state digest is invalid";
  if (record.confirmation_proof_ref !== undefined && !safeId(record.confirmation_proof_ref)) return "mapping confirmation proof reference is invalid";

  if (!exact(record.mapping, MAPPING_REQUIRED, MAPPING_OPTIONAL)) return "mapping has unknown or missing fields";
  const mapping = record.mapping;
  if (mapping.schema_version !== 1 || mapping.mapping_id !== mappingId || !isSafeCtoExecutionId(mapping.mapping_id)
    || typeof mapping.mapping_hash !== "string" || !isSha256Hex(mapping.mapping_hash)
    || mapping.mapping_id !== `cto-mapping-${mapping.mapping_hash.slice(0, 32)}`
    || !Number.isSafeInteger(mapping.mapping_version) || (mapping.mapping_version as number) < 1
    || !text(mapping.created_at) || (mapping.updated_at !== undefined && !text(mapping.updated_at))
    || mapping.execution_choice !== "cto"
    || (mapping.cto_run_id !== undefined && mapping.cto_run_id !== ctoRunId)
    || !Array.isArray(mapping.feature_ids) || mapping.feature_ids.length !== selections.length
    || mapping.feature_ids.length > MAX_CTO_MAPPING_FEATURES
    || !mapping.feature_ids.every((item: unknown) => isSafeFeatureId(item))
    || new Set(mapping.feature_ids as string[]).size !== mapping.feature_ids.length
    || !Array.isArray(mapping.selections) || mapping.selections.length !== selections.length
    || !Array.isArray(mapping.handoff_bindings) || mapping.handoff_bindings.length !== selections.length
    || !Array.isArray(mapping.task_to_slice) || mapping.task_to_slice.length > MAX_CTO_MAPPING_TASKS
    || !Array.isArray(mapping.shared_contracts) || mapping.shared_contracts.length > MAX_CTO_MAPPING_CONTRACTS
    || !Array.isArray(mapping.parallelization) || mapping.parallelization.length > MAX_CTO_MAPPING_PARALLELIZATION
    || (mapping.checkpoint_ref !== null && !text(mapping.checkpoint_ref))
    || !["candidate", "awaiting_confirmation", "confirmed", "revision_required", "stopped", "stale", "blocked", "aborted", "quarantined"].includes(String(mapping.status))) return "mapping envelope is invalid or exceeds domain bounds";
  if (mapping.status === "confirmed" && (typeof record.confirmation_state_after_digest !== "string" || typeof record.confirmation_proof_ref !== "string")) return "confirmed mapping is missing its authenticated confirmation image";
  if (mapping.status !== "confirmed" && (record.confirmation_state_after_digest !== undefined || record.confirmation_proof_ref !== undefined)) return "non-confirmed mapping must not retain a confirmation proof reference";
  if (digestOf(mappingHashBody(mapping)) !== mapping.mapping_hash) return "mapping content does not match its canonical hash";
  for (let i = 0; i < selections.length; i += 1) {
    const expected = selections[i] as Record<string, unknown>;
    const selected = mapping.selections[i];
    if (!exact(selected, SELECTION_KEYS) || selected.feature_id !== expected.feature_id || selected.run_key !== expected.run_key || mapping.feature_ids[i] !== expected.feature_id) return "mapping selectors do not match the record selectors";
  }
  if (!exact(mapping.execution, EXECUTION_KEYS) || mapping.execution.choice !== "cto"
    || !isSafeCtoExecutionId(mapping.execution.wave_id) || !isSafeCtoExecutionId(mapping.execution.source_id) || !safeId(mapping.execution.capability_id) || !safeId(mapping.execution.capability_epoch)) return "mapping execution authority is invalid";

  const taskKeys = new Set<string>();
  const sliceIds = new Set<string>();
  const teamIds = new Set<string>();
  for (const owner of mapping.task_to_slice as unknown[]) {
    if (!exact(owner, TASK_KEYS) || !isSafeFeatureId(owner.feature_id) || !features.has(owner.feature_id)
      || !text(owner.task_id) || !safeId(owner.team_id) || !safeId(owner.slice_id)
      || !strings(owner.requirement_ids, MAX_CTO_SPECIFICATION_SCOPE_ENTRIES)
      || !strings(owner.verification_ids, MAX_CTO_SPECIFICATION_SCOPE_ENTRIES)
      || !strings(owner.evidence_refs, MAX_CTO_SPECIFICATION_SCOPE_ENTRIES, text)
      || !strings(owner.depends_on, MAX_CTO_SPECIFICATION_SCOPE_ENTRIES, text)) return "mapping task ownership is invalid";
    const key = JSON.stringify({ feature_id: owner.feature_id, task_id: owner.task_id });
    if (taskKeys.has(key) || sliceIds.has(owner.slice_id) || teamIds.has(owner.team_id)) return "mapping task ownership contains duplicate slice, team, or task owners";
    taskKeys.add(key);
    sliceIds.add(owner.slice_id);
    teamIds.add(owner.team_id);
  }
  const contractIds = new Set<string>();
  for (const contract of mapping.shared_contracts as unknown[]) {
    if (!exact(contract, CONTRACT_KEYS) || !safeId(contract.contract_id) || contractIds.has(contract.contract_id)
      || !text(contract.contract) || !text(contract.owner) || !strings(contract.task_ids, MAX_TASKS, canonicalTaskIdentity)
      || !Number.isSafeInteger(contract.order) || (contract.order as number) < 0 || !largeText(contract.reason)
      || (contract.task_ids as string[]).some((taskId) => !taskKeys.has(taskId))) return "mapping shared contracts are invalid";
    contractIds.add(contract.contract_id);
  }
  const parallelIds = new Set<string>();
  for (const decision of mapping.parallelization as unknown[]) {
    if (!exact(decision, PARALLEL_KEYS) || !safeId(decision.slice_id) || parallelIds.has(decision.slice_id)
      || !["parallel", "serial"].includes(String(decision.decision)) || !text(decision.reason)
      || (decision.worktree !== "same_branch" && decision.worktree !== "separate_worktree")
      || !strings(decision.depends_on_slice_ids, MAX_TASKS)
      || !strings(decision.shared_contract_ids, MAX_CTO_MAPPING_CONTRACTS)
      || (decision.depends_on_slice_ids as string[]).some((sliceId) => !sliceIds.has(sliceId) || sliceId === decision.slice_id)
      || (decision.shared_contract_ids as string[]).some((contractId) => !contractIds.has(contractId))) return "mapping parallelization is invalid";
    parallelIds.add(decision.slice_id);
  }
  if (parallelIds.size !== sliceIds.size
    || [...parallelIds].some((sliceId) => !sliceIds.has(sliceId))
    || [...sliceIds].some((sliceId) => !parallelIds.has(sliceId))) return "mapping parallelization does not exactly cover every task slice";

  const bindingFeatures = new Set<string>();
  for (const binding of mapping.handoff_bindings as unknown[]) {
    if (!exact(binding, BINDING_KEYS) || !isSafeFeatureId(binding.feature_id) || !features.has(binding.feature_id)
      || bindingFeatures.has(binding.feature_id) || !safeId(binding.handoff_id) || !isSha256Hex(binding.handoff_digest)
      || !Array.isArray(binding.artifact_versions) || binding.artifact_versions.length > MAX_CTO_MAPPING_ARTIFACT_VERSIONS) return "mapping handoff bindings are invalid";
    bindingFeatures.add(binding.feature_id);
    const artifacts = new Set<string>();
    for (const artifact of binding.artifact_versions as unknown[]) {
      if (!exact(artifact, ARTIFACT_KEYS) || !safeId(artifact.artifact_id) || artifacts.has(artifact.artifact_id)
        || !["specify", "plan", "tasks", "import_snapshot", "supplement"].includes(String(artifact.kind))
        || !Number.isSafeInteger(artifact.version) || (artifact.version as number) < 1 || !isSha256Hex(artifact.sha256)) return "mapping artifact versions are invalid";
      artifacts.add(artifact.artifact_id);
    }
  }
  if (bindingFeatures.size !== features.size) return "mapping handoff bindings do not cover every selected feature";
  return null;
}

export type BoundedCtoMappingRecord = {
  record: Record<string, unknown>;
  raw: string;
  digest: string;
  path: string;
  dev: number;
  ino: number;
};
export type BoundedCtoMappingRecordResult = { ok: true; value: BoundedCtoMappingRecord } | { ok: false; error: string };
export type BoundedCtoMappingRecordReadOptions = {
  afterRead?: (context: { path: string; relative_path: string; dev: number; ino: number }) => void;
};

/** Read and validate a mapping through the already-open root pin. `path` is root-relative. */
export function readPinnedCtoMappingRecord(
  pinnedRoot: PinnedProjectRoot,
  path: string,
  ctoRunId: string,
  mappingId: string,
  options?: BoundedCtoMappingRecordReadOptions,
): BoundedCtoMappingRecordResult {
  if (!isSafeCtoRunId(ctoRunId) || !isSafeCtoExecutionId(mappingId) || !isSafeRelativePath(path)) return { ok: false, error: "mapping path or identity is unsafe" };
  try {
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before mapping read" };
    const before = pinnedRoot.pathEntryInfo(path);
    if (!before || before.kind !== "file") return { ok: false, error: "mapping path is missing or not a regular file" };
    const source = pinnedRoot.readFile(path, { maxBytes: MAX_CTO_MAPPING_RECORD_BYTES });
    options?.afterRead?.({ path: pinnedRoot.anchorPath(path), relative_path: path, dev: source.dev, ino: source.ino });
    const after = pinnedRoot.pathEntryInfo(path);
    if (!after || after.kind !== "file"
      || after.dev !== source.dev || after.ino !== source.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      return { ok: false, error: "mapping record changed while it was being read" };
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    const parsed = JSON.parse(raw) as unknown;
    const error = validateCtoMappingRecord(parsed, ctoRunId, mappingId);
    if (error) return { ok: false, error };
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed after mapping read" };
    return { ok: true, value: { record: parsed as Record<string, unknown>, raw, digest: sha256Hex(raw), path, dev: source.dev, ino: source.ino } };
  } catch (error) {
    return { ok: false, error: `mapping record is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

