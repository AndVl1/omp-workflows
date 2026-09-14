/**
 * Consilium fan-in: per-slot artifact provenance and deterministic synthesis.
 *
 * Every consilium dispatch slot owns a stable namespaced artifact id. Durable
 * filenames encode exact UTF-8 artifact/slot identity (or a bounded digest with
 * an identity envelope), so punctuation and Unicode normalization never alias.
 * all expected results before handoff:
 *
 *   - missing: a declared produce with no slot contribution, or a slot that
 *     recorded no artifact at all -> blocks with a diagnostic;
 *   - collision: one slot recording the same artifact twice with different
 *     content -> blocks at completion time;
 *   - conflict: slots disagreeing on a schema-required scalar field -> blocks
 *     with field diagnostics by default (strict). The ONLY way a required
 *     scalar disagreement may be resolved without blocking is an explicit,
 *     documented `stage.fan_in.resolutions` entry declaring the deliberate
 *     resolution for exactly `(artifact, field)`. Every applied resolution —
 *     and every lenient-policy resolution when a caller explicitly opts out
 *     of strict via `setFanInPolicy` — is recorded durably in the synthesis
 *     provenance (`conflicts`) with the winning slot and the losing values.
 *     A disagreement is never discarded silently.
 *
 * Synthesis is deterministic: arrays concatenate in roster order with
 * canonical-JSON identity dedupe, objects merge recursively, scalars first-wins; the
 * shared `<produce>.json` is written from the merged value and the
 * contributing slots are recorded as synthesis provenance.
 */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  createArtifactStructureBudget,
  parseArtifactJson,
  validateArtifactStructure,
  ARTIFACT_STRUCTURE_LIMITS,
  MAX_ARTIFACT_BYTES,
  type ArtifactStructureBudget,
} from "./artifacts.js";
import { PinnedProjectRoot, PinnedRootError, type PinnedRootWriteReceipt } from "../specification/pinned-root.js";
import { requiredFieldsOf } from "./artifact-contract.js";
import type { FanInConflictRecord, SlotArtifactRecord, StageFanInResolution, StageSlotRecords, TeamState } from "./types.js";
import { evaluateCtoSpecificationConformance, type EvaluateCtoSpecificationConformanceInput, type CtoSpecificationConformanceResult } from "../specification/conformance.js";
import { canonicalJson, digestOf } from "../specification/validation.js";
const MAX_FAN_IN_ARTIFACT_PATH_LENGTH = 4096;

export type FanInSnapshotReadCode =
  | "root_unauthorized"
  | "record_invalid"
  | "path_unauthorized"
  | "not_found"
  | "not_regular"
  | "too_large"
  | "size_mismatch"
  | "digest_mismatch"
  | "unstable"
  | "malformed"
  | "structure_limit"
  | "read_failed";

type SnapshotReadResult =
  | { ok: true; value: unknown }
  | { ok: false; code: FanInSnapshotReadCode; error: string };
function boundedFanInFailure(): string {
  return "consilium fan-in failed safely: bounded structure, canonicalization, or merge failure";
}


function canonicalIdentity(value: unknown, cache: WeakMap<object, string>, budget: { work: number }): string {
  if (value && typeof value === "object") {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
  }
  const canonical = canonicalJson(value);
  const identity = typeof canonical === "string" ? canonical : "undefined";
  budget.work += Buffer.byteLength(identity, "utf8");
  if (budget.work > ARTIFACT_STRUCTURE_LIMITS.maxWork) throw new Error("fan-in canonicalization work budget exceeded");
  if (value && typeof value === "object") cache.set(value, identity);
  return identity;
}


/** Read exact recorded bytes from one contained, regular, stable snapshot before parsing JSON. */
function unwrapSlotArtifactSnapshot(
  value: unknown,
  record: SlotArtifactRecord,
  artifactId: string | undefined,
  slot: string | undefined,
): SnapshotReadResult {
  if (artifactId === undefined || slot === undefined) return { ok: true, value };
  const basename = record.path.split(/[\\/]/u).at(-1)?.replace(/\.json$/u, "");
  const canonicalPath = basename === durableNamespacedArtifactId(artifactId, slot);
  const legacyPath = basename === legacyNamespacedArtifactId(artifactId, slot);
  if (!canonicalPath && !legacyPath) {
    return { ok: false, code: "path_unauthorized", error: "persisted artifact filename does not bind to its exact slot identity" };
  }
  const marker = value && typeof value === "object" && "$omp_slot_artifact" in value
    ? (value as Record<string, unknown>).$omp_slot_artifact
    : undefined;
  if (!marker) {
    if (canonicalPath || record.artifact_id !== undefined || record.slot_id !== undefined || record.provider_id !== undefined) {
      return { ok: false, code: "malformed", error: "canonical slot artifact is missing its identity envelope" };
    }
    // Schema-1 raw files are accepted only for an unannotated, exact legacy
    // path. New writes always carry the envelope above.
    return { ok: true, value };
  }
  if (!marker || typeof marker !== "object") {
    return { ok: false, code: "malformed", error: "slot artifact identity envelope is malformed" };
  }
  const identity = marker as Record<string, unknown>;
  if (
    identity.schema_version !== 1
    || typeof identity.artifact_id !== "string"
    || typeof identity.slot_id !== "string"
    || typeof identity.provider_id !== "string"
    || typeof identity.identity_sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(identity.identity_sha256)
    || identity.artifact_id !== artifactId
    || identity.slot_id !== slot
    || (record.artifact_id !== undefined && record.artifact_id !== identity.artifact_id)
    || (record.slot_id !== undefined && record.slot_id !== identity.slot_id)
    || (record.provider_id !== undefined && record.provider_id !== identity.provider_id)
    || digestOf(slotArtifactIdentity(identity.artifact_id, identity.slot_id, identity.provider_id)) !== identity.identity_sha256
  ) {
    return { ok: false, code: "malformed", error: "slot artifact identity envelope does not match its bound slot/provider" };
  }
  return { ok: true, value: (value as Record<string, unknown>).value };
}

/** Read a recorded slot snapshot through one borrowed pinned root. */
function readSnapshotPinned(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  record: SlotArtifactRecord,
  artifactId?: string,
  slot?: string,
): SnapshotReadResult {
  if (
    !record
    || typeof record.path !== "string"
    || record.path.length === 0
    || record.path.length > MAX_FAN_IN_ARTIFACT_PATH_LENGTH
    || !isAbsolute(record.path)
    || typeof record.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(record.sha256)
    || !Number.isSafeInteger(record.size_bytes)
    || record.size_bytes < 0
  ) {
    return { ok: false, code: "record_invalid", error: "persisted artifact record is malformed" };
  }
  if (record.size_bytes > MAX_ARTIFACT_BYTES) {
    return { ok: false, code: "too_large", error: `persisted artifact record exceeds the ${MAX_ARTIFACT_BYTES}-byte limit` };
  }
  const relativePath = pinnedRoot.relativePath(record.path);
  const prefix = artifactsDirRelative.length > 0 ? `${artifactsDirRelative}/` : "";
  if (relativePath === null || !relativePath.startsWith(prefix) || relativePath === artifactsDirRelative) {
    return { ok: false, code: "path_unauthorized", error: "persisted artifact path is outside the authorized artifact root" };
  }
  try {
    if (!pinnedRoot.isStable()) return { ok: false, code: "unstable", error: "pinned project root changed before artifact read" };
    const entry = pinnedRoot.readFile(relativePath, { maxBytes: MAX_ARTIFACT_BYTES });
    const bytes = Buffer.from(entry.bytes);
    if (!pinnedRoot.isStable()) return { ok: false, code: "unstable", error: "pinned project root changed while artifact was read" };
    if (bytes.byteLength !== record.size_bytes) {
      return { ok: false, code: "size_mismatch", error: `persisted artifact size ${bytes.byteLength} does not match recorded size ${record.size_bytes}` };
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== record.sha256) {
      return { ok: false, code: "digest_mismatch", error: `persisted artifact digest '${actualSha256}' does not match recorded digest '${record.sha256}'` };
    }
    const parsed = parseArtifactJson(bytes);
    if (!parsed.ok) {
      return {
        ok: false,
        code: parsed.kind === "structure-limit" ? "structure_limit" : "malformed",
        error: parsed.reason,
      };
    }
    const unwrapped = unwrapSlotArtifactSnapshot(parsed.value, record, artifactId, slot);
    if (!unwrapped.ok) return unwrapped;
    const structure = validateArtifactStructure(unwrapped.value);
    if (!structure.ok) return { ok: false, code: "structure_limit", error: structure.error };
    return { ok: true, value: unwrapped.value };
  } catch (error) {
    if (error instanceof PinnedRootError) {
      const symlink = /symbolic link|symlink|too many levels/iu.test(error.message);
      const code = symlink || error.code === "path_unauthorized" ? "path_unauthorized"
        : error.code === "not_found" ? "not_found"
          : error.code === "not_regular" ? "not_regular"
            : error.code === "changed" ? "unstable"
              : "read_failed";
      return { ok: false, code, error: `persisted artifact could not be read safely: ${error.message}` };
    }
    return { ok: false, code: "malformed", error: "persisted artifact payload is not valid JSON" };
  }
}

export interface FanInPolicy {
  /** Require per-slot provenance and deterministic synthesis for multi-slot consilium stages. */
  enabled: boolean;
  /** Block on required-scalar disagreements between slots (default true). */
  strict: boolean;
  /**
   * Explicit, documented resolutions for deliberately multi-option fields.
   * A resolution applies only to exactly `(artifact, field)`; every applied
   * resolution is recorded in the synthesis provenance (`conflicts`).
   */
  resolutions?: StageFanInResolution[];
}

export const DEFAULT_FAN_IN_POLICY: FanInPolicy = { enabled: true, strict: true };

/**
 * Validate a stage's declared fan-in resolutions. Returns diagnostics (empty
 * when valid). Unknown strategies and missing rationales fail closed at load
 * so a resolution can never silently resolve a disagreement it does not
 * deliberately document.
 */
export function validateStageFanInResolutions(stage: { id: string; fan_in?: { resolutions?: StageFanInResolution[] } }): string[] {
  const diagnostics: string[] = [];
  for (const resolution of stage.fan_in?.resolutions ?? []) {
    if (!resolution || typeof resolution.artifact !== "string" || !resolution.artifact.trim()) {
      diagnostics.push(`stage '${stage.id}': fan_in resolution requires a non-empty artifact`);
      continue;
    }
    if (typeof resolution.field !== "string" || !resolution.field.trim()) {
      diagnostics.push(`stage '${stage.id}': fan_in resolution for '${resolution.artifact}' requires a non-empty field`);
      continue;
    }
    if (resolution.strategy !== "first_slot") {
      diagnostics.push(
        `stage '${stage.id}': fan_in resolution for '${resolution.artifact}.${resolution.field}' uses unsupported strategy '${String(resolution.strategy)}'`,
      );
      continue;
    }
    if (typeof resolution.rationale !== "string" || !resolution.rationale.trim()) {
      diagnostics.push(`stage '${stage.id}': fan_in resolution for '${resolution.artifact}.${resolution.field}' requires a documented rationale`);
    }
  }
  return diagnostics;
}

/** Legacy lossy spelling retained only for in-run migration/read compatibility. */
export function sanitizeSlot(slot: string): string {
  return slot.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** The pre-v1 slot filename spelling; never use this for new writes. */
export function legacyNamespacedArtifactId(artifactId: string, slot: string): string {
  return `${artifactId}-${sanitizeSlot(slot)}`;
}

/**
 * Build a bounded, injective slot artifact filename.
 *
 * Short identities contain the exact UTF-8 bytes in base64url form. Very long
 * identities use a SHA-256 tuple key so the filename stays below NAME_MAX;
 * the persisted envelope remains the authority and rejects a hash collision.
 */
export function durableNamespacedArtifactId(artifactId: string, slot: string): string {
  const encodedArtifact = Buffer.from(artifactId, "utf8").toString("base64url") || "0";
  const encodedSlot = Buffer.from(slot, "utf8").toString("base64url") || "0";
  const reversible = `slot-v1.${encodedArtifact}.${encodedSlot}`;
  if (Buffer.byteLength(`${reversible}.json`, "utf8") <= 220) return reversible;
  const digest = createHash("sha256").update(artifactId, "utf8").update("\0", "utf8").update(slot, "utf8").digest("hex");
  return `slot-v1-h.${digest}`;
}

export function isDurableNamespacedArtifactId(id: string, artifactId: string, slot: string): boolean {
  return id === durableNamespacedArtifactId(artifactId, slot);
}

/** Old public helper retained for callers reading legacy state. */
export function namespacedArtifactId(artifactId: string, slot: string): string {
  return legacyNamespacedArtifactId(artifactId, slot);
}

/** Whether an id follows the legacy lossy slot namespace for a given slot. */
export function isNamespacedArtifactId(id: string, slot: string): boolean {
  const suffix = `-${sanitizeSlot(slot)}`;
  return id.endsWith(suffix) && legacyNamespacedArtifactId(id.slice(0, -suffix.length), slot) === id;
}

export interface SlotArtifactEnvelope {
  $omp_slot_artifact: {
    schema_version: 1;
    artifact_id: string;
    slot_id: string;
    provider_id: string;
    identity_sha256: string;
  };
  value: unknown;
}

function slotArtifactIdentity(artifactId: string, slotId: string, providerId: string): Record<string, string> {
  return { artifact_id: artifactId, slot_id: slotId, provider_id: providerId };
}

export function createSlotArtifactEnvelope(
  artifactId: string,
  slotId: string,
  providerId: string,
  value: unknown,
): SlotArtifactEnvelope {
  const identity = slotArtifactIdentity(artifactId, slotId, providerId);
  return {
    $omp_slot_artifact: {
      schema_version: 1,
      artifact_id: artifactId,
      slot_id: slotId,
      provider_id: providerId,
      identity_sha256: digestOf(identity),
    },
    value,
  };
}

export function slotArtifactEnvelopeBytes(
  artifactId: string,
  slotId: string,
  providerId: string,
  value: unknown,
): string {
  return JSON.stringify(createSlotArtifactEnvelope(artifactId, slotId, providerId, value), null, 2) + "\n";
}

 

export function slotRecordsFor(state: TeamState, stageId: string): StageSlotRecords | null {
  return state.slot_artifacts?.[stageId] ?? null;
}
/**
 * Resolve a slot's contribution to a declared produce. New records are
 * keyed by the shared logical id; legacy records may use either spelling.
 */
export function slotArtifactRecord(
  records: StageSlotRecords,
  slot: string,
  artifactId: string,
): SlotArtifactRecord | undefined {
  const slotRecords = records.slots[slot];
  if (!slotRecords) return undefined;
  return slotRecords[artifactId]
    ?? slotRecords[durableNamespacedArtifactId(artifactId, slot)]
    ?? slotRecords[legacyNamespacedArtifactId(artifactId, slot)];
}
function artifactIdForSlotKey(key: string, slot: string, produces: string[]): string | null {
  const matches = produces.filter((artifactId) =>
    key === artifactId
    || key === durableNamespacedArtifactId(artifactId, slot)
    || key === legacyNamespacedArtifactId(artifactId, slot),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function validateSlotArtifactMatrix(
  records: StageSlotRecords,
  expectedSlots: string[],
  produces: string[],
): string | null {
  if (new Set(expectedSlots).size !== expectedSlots.length) return "expected slot roster contains duplicate identities";
  if (new Set(produces).size !== produces.length) return "stage produces contains duplicate artifact ids";
  const expected = new Set(expectedSlots);
  for (const slot of Object.keys(records.slots)) {
    if (!expected.has(slot)) return `slot artifact records contain unexpected slot '${slot}'`;
  }
  for (const slot of expectedSlots) {
    const slotRecords = records.slots[slot] ?? {};
    const seen = new Set<string>();
    for (const key of Object.keys(slotRecords)) {
      const artifactId = artifactIdForSlotKey(key, slot, produces);
      if (!artifactId) return `slot '${slot}' contains an unexpected or ambiguous artifact key '${key}'`;
      if (seen.has(artifactId)) return `slot '${slot}' contains duplicate records for artifact '${artifactId}'`;
      seen.add(artifactId);
    }
  }
  return null;
}

/**
 * Missing-result check at advance: every expected slot must have every
 * declared produce recorded. Extras and duplicate aliases are rejected by
 * validateSlotArtifactMatrix before synthesis.
 */
export function missingSlotResults(
  state: TeamState,
  stageId: string,
  expectedSlots: string[],
  produces: string[],
): Array<{ slot: string; artifactId: string }> {
  const records = slotRecordsFor(state, stageId);
  if (!records) {
    return expectedSlots.flatMap((slot) => produces.map((artifactId) => ({ slot, artifactId })));
  }
  const missing: Array<{ slot: string; artifactId: string }> = [];
  for (const slot of expectedSlots) {
    for (const artifactId of produces) {
      if (slotArtifactRecord(records, slot, artifactId) === undefined) missing.push({ slot, artifactId });
    }
  }
  return missing;
}

export type MergeResult =
  | { ok: true; value: unknown; conflicts?: FanInConflictRecord[] }
  | { ok: false; error: string };

/** One slot's contribution to a produce, in roster order. */
interface MergeEntry {
  slot: string;
  value: unknown;
  node?: MergedNode;
}

type MergeChildren = Map<string, MergedNode> | MergedNode[];

/** A merged value plus exact recursive provenance for every object key/array item. */
interface MergedNode {
  value: unknown;
  origin: string | null;
  children?: MergeChildren;
}

function provenanceNode(value: unknown, origin: string): MergedNode {
  if (Array.isArray(value)) {
    return { value, origin, children: value.map((item) => provenanceNode(item, origin)) };
  }
  if (value && typeof value === "object") {
    const children = new Map<string, MergedNode>();
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) children.set(key, provenanceNode(child, origin));
    return { value, origin, children };
  }
  return { value, origin };
}

function objectProvenance(node: MergedNode, value: Record<string, unknown>): Map<string, MergedNode> {
  if (node.children instanceof Map) return node.children;
  const children = new Map<string, MergedNode>();
  for (const [key, child] of Object.entries(value)) children.set(key, provenanceNode(child, node.origin ?? ""));
  return children;
}

function arrayProvenance(node: MergedNode, value: unknown[]): MergedNode[] {
  if (Array.isArray(node.children)) return node.children;
  return value.map((item) => provenanceNode(item, node.origin ?? ""));
}

interface MergeContext {
  canonicalCache: WeakMap<object, string>;
  budget: { work: number };
}

interface PendingFanInArtifact {
  artifactId: string;
  value: unknown;
  contributors: string[];
  conflicts?: FanInConflictRecord[];
}

/**
 * Deterministic merge of slot values in roster order. Arrays concatenate and
 * dedupe by JSON identity; objects merge recursively; scalars keep the first
 * value. In strict mode (the shipped default), schema-required scalar
 * disagreements block unless an explicit {@link StageFanInResolution} for
 * exactly `(artifactId, field)` is declared — and every resolved
 * disagreement is appended to `conflicts` with the winning slot and losing
 * values. Optional scalar disagreements always resolve first-wins (the
 * schema does not require agreement there).
 */
export function mergeSlotValues(
  values: unknown[],
  requiredFields: string[] | null,
  strict: boolean,
  artifactId: string,
  resolutions: StageFanInResolution[] = [],
): MergeResult {
  try {
    const entries: MergeEntry[] = values.map((value, index) => ({ slot: `slot-${index}`, value }));
    return mergeSlotEntries(entries, requiredFields, strict, artifactId, resolutions, new Date().toISOString());
  } catch {
    return { ok: false, error: boundedFanInFailure() };
  }
}

function mergeSlotEntries(
  entries: MergeEntry[],
  requiredFields: string[] | null,
  strict: boolean,
  artifactId: string,
  resolutions: StageFanInResolution[],
  resolvedAt: string,
): MergeResult {
  try {
    if (entries.length === 0) return { ok: true, value: undefined };
    const structureBudget: ArtifactStructureBudget = createArtifactStructureBudget();
    for (const entry of entries) {
      const structure = validateArtifactStructure(entry.value, structureBudget);
      if (!structure.ok) return { ok: false, error: structure.error };
    }
    const context: MergeContext = {
      canonicalCache: new WeakMap<object, string>(),
      budget: { work: structureBudget.work },
    };
    const conflicts: FanInConflictRecord[] = [];
    let merged: MergedNode = provenanceNode(entries[0]!.value, entries[0]!.slot);
    for (let index = 1; index < entries.length; index += 1) {
      const next = entries[index]!;
      const step = mergePair(merged, next, requiredFields ?? [], strict, artifactId, "$", resolutions, conflicts, resolvedAt, context);
      if (!step.ok) return step;
      merged = step;
    }
    return { ok: true, value: merged.value, ...(conflicts.length > 0 ? { conflicts } : {}) };
  } catch {
    return { ok: false, error: boundedFanInFailure() };
  }
}

function mergePair(
  left: MergedNode,
  right: MergeEntry,
  requiredFields: string[],
  strict: boolean,
  artifactId: string,
  path: string,
  resolutions: StageFanInResolution[],
  conflicts: FanInConflictRecord[],
  resolvedAt: string,
  context: MergeContext,
): { ok: true; value: unknown; origin: string | null; children?: MergeChildren } | { ok: false; error: string } {
  const l = left.value;
  const r = right.value;
  if (canonicalIdentity(l, context.canonicalCache, context.budget) === canonicalIdentity(r, context.canonicalCache, context.budget)) {
    return { ok: true, ...left };
  }
  if (Array.isArray(l) && Array.isArray(r)) {
    const mergedNodes = [...arrayProvenance(left, l)];
    const rightNode = right.node ?? provenanceNode(r, right.slot);
    const rightNodes = arrayProvenance(rightNode, r);
    const identities = new Set<string>();
    for (const item of mergedNodes) identities.add(canonicalIdentity(item.value, context.canonicalCache, context.budget));
    for (const item of rightNodes) {
      const identity = canonicalIdentity(item.value, context.canonicalCache, context.budget);
      if (!identities.has(identity)) {
        identities.add(identity);
        mergedNodes.push(item);
      }
    }
    if (mergedNodes.length > ARTIFACT_STRUCTURE_LIMITS.maxArrayItems) {
      return {
        ok: false,
        error: `fan-in structure limit exceeded: merged array length exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxArrayItems}`,
      };
    }
    return { ok: true, value: mergedNodes.map((item) => item.value), origin: left.origin, children: mergedNodes };
  }
  if (l && r && typeof l === "object" && typeof r === "object" && !Array.isArray(l) && !Array.isArray(r)) {
    const leftObject = l as Record<string, unknown>;
    const rightObject = r as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    const children = new Map<string, MergedNode>();
    const leftChildren = objectProvenance(left, leftObject);
    const rightNode = right.node ?? provenanceNode(r, right.slot);
    const rightChildren = objectProvenance(rightNode, rightObject);
    for (const [key, value] of Object.entries(leftObject)) {
      const child = leftChildren.get(key) ?? provenanceNode(value, left.origin ?? right.slot);
      merged[key] = child.value;
      children.set(key, child);
    }
    for (const [key, rightValue] of Object.entries(rightObject)) {
      const rightChild = rightChildren.get(key) ?? provenanceNode(rightValue, right.slot);
      const leftChild = children.get(key);
      if (!leftChild) {
        merged[key] = rightChild.value;
        children.set(key, rightChild);
        continue;
      }
      const step = mergePair(
        leftChild,
        { slot: right.slot, value: rightValue, node: rightChild },
        requiredFields,
        strict,
        artifactId,
        `${path}.${key}`,
        resolutions,
        conflicts,
        resolvedAt,
        context,
      );
      if (!step.ok) return step;
      merged[key] = step.value;
      children.set(key, step);
    }
    return {
      ok: true,
      value: merged,
      origin: [...children.values()].find((child) => child.origin !== null)?.origin ?? left.origin,
      children,
    };
  }
  // Scalar disagreement.
  const field = path.startsWith("$.") ? path.slice(2) : path;
  const isRequired = requiredFields.includes(field);
  if (isRequired) {
    const resolution = resolutions.find((candidate) => candidate.artifact === artifactId && candidate.field === field);
    if (strict && !resolution) {
      return {
        ok: false,
        error:
          `fan-in conflict for artifact '${artifactId}' at '${path}': slots disagree on required scalar field '${field}' ` +
          `and no explicit resolution is declared (declare stage.fan_in.resolutions for '${artifactId}.${field}' or resolve the disagreement)`,
      };
    }
    if (resolution && resolution.strategy !== "first_slot") {
      // Fail closed: an unsupported strategy must never resolve silently.
      return {
        ok: false,
        error: `fan-in conflict for artifact '${artifactId}' at '${path}': declared resolution strategy '${resolution.strategy}' is not supported`,
      };
    }
    conflicts.push({
      artifact: artifactId,
      field,
      strategy: resolution ? "first_slot" : "lenient",
      resolved_value: l,
      winner_slot: left.origin ?? right.slot,
      losing_values: [{ slot: right.slot, value: r }],
      rationale:
        resolution?.rationale ??
        "lenient fan-in policy (strict disabled): required-scalar disagreements resolve deterministically first-slot-wins and are recorded, never discarded",
      resolved_at: resolvedAt,
    });
    return { ok: true, value: l, origin: left.origin };
  }
  // Optional scalar disagreement: not part of the required contract; resolves
  // deterministically first-wins (arrays/objects merge above). Not recorded
  // as a conflict because the schema does not require agreement.
  return { ok: true, value: l, origin: left.origin };
}



/**
 * CTO specification conformance adapter for engine fan-in consumers.
 * The specification module owns the canonical evaluator; this seam adds CTO
 * fan-in access without introducing a second implementation.
 */
export function evaluateCtoSpecificationConformanceFanIn(
  input: EvaluateCtoSpecificationConformanceInput,
): CtoSpecificationConformanceResult {
  return evaluateCtoSpecificationConformance(input);
}

export type FanInBlockedCode = FanInSnapshotReadCode | "incomplete" | "records_missing" | "merge_conflict" | "write_failed" | "fan_in_failed";

export interface FanInWriteOptions {
  /** Caller-owned guard invoked immediately before publishing the shared artifact batch. */
  beforeWrite?: () => void;
  /** Register exact shared-file rollback with the enclosing durable transaction. */
  registerRollback?: (cleanup: () => void) => void;
}

export type SynthesisResult =
  | { ok: true; state: TeamState; shared: Record<string, { slots: string[]; synthesized_at: string; conflicts?: FanInConflictRecord[] }> }
  | { ok: false; code: FanInBlockedCode; error: string; state?: TeamState };

/**
 * Deterministically synthesize the shared artifacts for a multi-slot
 * consilium stage from the per-slot snapshots, and write the merged values
 * to `<artifactsDir>/<produce>.json`. Returns the updated state carrying the
 * synthesis provenance, including every resolved required-scalar
 * disagreement (`conflicts`) with the winning slot and losing values.
 */
export function synthesizeArtifacts(
  state: TeamState,
  stageId: string,
  artifactsDir: string,
  produces: string[],
  expectedSlots: string[],
  policy: FanInPolicy = DEFAULT_FAN_IN_POLICY,
  pinnedRoot?: PinnedProjectRoot,
  options: FanInWriteOptions = {},
): SynthesisResult {
  let ownedPinnedRoot: PinnedProjectRoot | null = null;
  try {
    if (!policy.enabled || expectedSlots.length <= 1) return { ok: true, state, shared: {} };
    const records = slotRecordsFor(state, stageId);
    if (records) {
      const matrixError = validateSlotArtifactMatrix(records, expectedSlots, produces);
      if (matrixError) return { ok: false, code: "record_invalid", error: `consilium fan-in: ${matrixError}` };
    }
    const missing = missingSlotResults(state, stageId, expectedSlots, produces);
    if (missing.length > 0) {
      const detail = missing.map((entry) =>
        `slot '${entry.slot}' is missing artifact '${entry.artifactId}'`,
      ).join("; ");
      return { ok: false, code: "incomplete", error: `consilium fan-in incomplete: ${detail}` };
    }
    if (!records) return { ok: false, code: "records_missing", error: "consilium fan-in records are missing" };
    if (!pinnedRoot) ownedPinnedRoot = PinnedProjectRoot.open(artifactsDir);
    const effectivePinnedRoot = pinnedRoot ?? ownedPinnedRoot;
    if (!effectivePinnedRoot) return { ok: false, code: "root_unauthorized", error: "consilium fan-in: artifact directory cannot be pinned" };
    if (!effectivePinnedRoot.isStable()) return { ok: false, code: "unstable", error: "consilium fan-in: pinned project root changed before synthesis" };
    const artifactsDirRelative = pinnedRoot ? effectivePinnedRoot.relativePath(artifactsDir) : "";
    if (artifactsDirRelative === null) return { ok: false, code: "root_unauthorized", error: "consilium fan-in: artifact directory is outside the pinned project root" };
    const shared: NonNullable<StageSlotRecords["shared"]> = {};
    const now = new Date().toISOString();
    const pending: PendingFanInArtifact[] = [];
    const resolutions = policy.resolutions ?? [];
    for (const artifactId of produces) {
      const contributors = expectedSlots.filter((slot) => slotArtifactRecord(records, slot, artifactId) !== undefined);
      const paths = new Set<string>();
      for (const slot of contributors) {
        const record = slotArtifactRecord(records, slot, artifactId)!;
        if (paths.has(record.path) && (record.artifact_id !== undefined || record.slot_id !== undefined || record.provider_id !== undefined)) {
          return { ok: false, code: "record_invalid", error: `consilium fan-in: artifact '${artifactId}' has colliding snapshot paths` };
        }
        paths.add(record.path);
      }
      const entries: MergeEntry[] = [];
      for (const slot of contributors) {
        const record = slotArtifactRecord(records, slot, artifactId)!;
        const snapshot = readSnapshotPinned(effectivePinnedRoot, artifactsDirRelative, record, artifactId, slot);
        if (!snapshot.ok) {
          return {
            ok: false,
            code: snapshot.code,
            error: `consilium fan-in: artifact '${artifactId}' (slot '${slot}'): ${snapshot.error}`,
          };
        }
        entries.push({ slot, value: snapshot.value });
      }
      const merged = mergeSlotEntries(entries, requiredFieldsOf(artifactId), policy.strict, artifactId, resolutions, now);
      if (!merged.ok) return { ok: false, code: "merge_conflict", error: merged.error };
      pending.push({ artifactId, value: merged.value, contributors, ...(merged.conflicts && merged.conflicts.length > 0 ? { conflicts: merged.conflicts } : {}) });
    }
    const publicationEntries: Array<{ path: string; content: string }> = [];
    for (const artifact of pending) {
      const structure = validateArtifactStructure(artifact.value);
      if (!structure.ok) return { ok: false, code: "write_failed", error: `consilium fan-in: shared artifact '${artifact.artifactId}' exceeds its bounded structure` };
      const content = JSON.stringify(artifact.value, null, 2) + "\n";
      if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) {
        return { ok: false, code: "write_failed", error: `consilium fan-in: shared artifact '${artifact.artifactId}' exceeds its persisted byte limit` };
      }
      const path = artifactsDirRelative.length > 0 ? `${artifactsDirRelative}/${artifact.artifactId}.json` : `${artifact.artifactId}.json`;
      publicationEntries.push({ path, content });
      const provenance: { slots: string[]; synthesized_at: string; conflicts?: FanInConflictRecord[] } = {
        slots: artifact.contributors,
        synthesized_at: now,
      };
      if (artifact.conflicts && artifact.conflicts.length > 0) provenance.conflicts = artifact.conflicts;
      shared[artifact.artifactId] = provenance;
    }
    const receipts: PinnedRootWriteReceipt[] = [];
    const rollback = (): void => {
      for (const receipt of receipts.slice().reverse()) receipt.rollback();
    };
    // Register before publication so a later outer-CAS failure can always
    // invoke the cleanup, while a callback/capture failure before write leaves
    // no visible artifact mutation.
    try {
      options.registerRollback?.(rollback);
      options.beforeWrite?.();
      if (artifactsDirRelative.length > 0) effectivePinnedRoot.ensureDirectory(artifactsDirRelative);
      receipts.push(...effectivePinnedRoot.writeAtomicFilesWithReceipts(publicationEntries));
      if (!effectivePinnedRoot.isStable()) throw new PinnedRootError("changed", "consilium fan-in: project root changed after shared artifact publication");
    } catch {
      rollback();
      return { ok: false, code: "write_failed", error: "consilium fan-in: shared artifact batch could not be persisted safely" };
    }
    const stageRecords: StageSlotRecords = { ...records, shared: { ...(records.shared ?? {}), ...shared } };
    return {
      ok: true,
      state: { ...state, slot_artifacts: { ...(state.slot_artifacts ?? {}), [stageId]: stageRecords } },
      shared,
    };
  } catch {
    return { ok: false, code: "fan_in_failed", error: boundedFanInFailure(), state };
  } finally {
    ownedPinnedRoot?.close();
  }
}
