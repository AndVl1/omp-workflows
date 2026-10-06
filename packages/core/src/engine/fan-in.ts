/**
 * Consilium fan-in: per-slot artifact provenance and deterministic synthesis.
 *
 * Every consilium dispatch slot contributes immutable receipt outputs under
 * its canonical `(stage, loop iteration, slot)` identity. Shared produce ids
 * are synthesized only after receipt identity and bytes are verified.
 * `advanceCursor` requires all expected results before handoff:
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
 * JSON-identity dedupe, objects merge recursively, scalars first-wins; the
 * shared `<produce>.json` is written from the merged value and the
 * contributing slots are recorded as synthesis provenance.
 */

import { createHash } from "node:crypto";
import { readArtifactFileSafe, writeArtifact } from "./artifacts.js";
import { requiredFieldsOf } from "./artifact-contract.js";
import type { FanInConflictRecord, SlotArtifactRecord, StageFanInResolution, StageSlotRecords, TeamState } from "./types.js";


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

export function sanitizeSlot(slot: string): string {
  return slot.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function namespacedArtifactId(artifactId: string, slot: string): string {
  return `${artifactId}-${sanitizeSlot(slot)}`;
}

/** Whether an id already follows the slot namespace for a given slot. */
export function isNamespacedArtifactId(id: string, slot: string): boolean {
  const suffix = `-${sanitizeSlot(slot)}`;
  return id.endsWith(suffix) && namespacedArtifactId(id.slice(0, -suffix.length), slot) === id;
}


/**
 * Build fan-in records exclusively from accepted immutable stage receipts.
 * `slot_artifacts` is deliberately not consulted: it is a derived legacy
 * projection and cannot establish producer, iteration, or immutable-file
 * authority.
 */
function canonicalSlotRecords(
  state: TeamState,
  stageId: string,
  produces: string[],
): { records: StageSlotRecords; error?: string } {
  const records: StageSlotRecords = { slots: {} };
  const expectedCapability = state.dispatch_capability?.issued_for;
  const activeDispatches = state.dispatch_capability?.dispatches ?? [];
  const successfulDispatches = new Map<string, number>();
  for (const dispatch of activeDispatches) {
    if (dispatch.status !== "succeeded") continue;
    successfulDispatches.set(dispatch.id, dispatch.attempt);
  }
  const restrictToCurrentDispatches = successfulDispatches.size > 0;
  const receipts = Object.values(state.stage_receipts ?? {}).filter((receipt) => {
    const identity = receipt.work_identity;
    if (identity.stage_id !== stageId) return false;
    if (restrictToCurrentDispatches) {
      const attempt = successfulDispatches.get(identity.dispatch_id);
      if (attempt === undefined || attempt !== identity.attempt) return false;
    }
    if (expectedCapability?.stage_cursor === stageId) {
      if (identity.stage_cursor !== expectedCapability.stage_cursor) return false;
      if (
        expectedCapability.loop_iteration !== undefined
        && identity.loop_iteration !== expectedCapability.loop_iteration
      ) return false;
    }
    return true;
  });
  if (receipts.length === 0) {
    return { records, error: `canonical stage receipts are missing for stage '${stageId}'` };
  }
  const collisions: string[] = [];
  for (const receipt of receipts) {
    const slot = receipt.work_identity.slot_id;
    const slotRecords = (records.slots[slot] ??= {});
    for (const output of receipt.outputs) {
      if (!produces.includes(output.artifact_id)) continue;
      const previous = slotRecords[output.artifact_id];
      if (previous && (previous.hash !== output.sha256 || previous.path !== output.immutable_ref)) {
        collisions.push(`${slot}/${output.artifact_id}`);
        continue;
      }
      slotRecords[output.artifact_id] = {
        path: output.immutable_ref,
        hash: output.sha256,
      };
    }
  }
  if (collisions.length > 0) {
    return { records, error: `consilium fan-in has conflicting canonical receipts for ${collisions.join(", ")}` };
  }
  return { records };
}

/**
 * Resolve a slot's contribution from the canonical receipt projection. The
 * projection retains the receipt's immutable reference and byte hash.
 */
export function slotArtifactRecord(
  records: StageSlotRecords,
  slot: string,
  artifactId: string,
): SlotArtifactRecord | undefined {
  return records.slots[slot]?.[artifactId] ?? records.slots[slot]?.[namespacedArtifactId(artifactId, slot)];
}

/**
 * Missing-result check at advance: every declared produce must have at least
 * one canonical receipt contribution and every expected slot must have
 * recorded at least one artifact. Returns the missing list (empty = complete).
 */
export function missingSlotResults(
  state: TeamState,
  stageId: string,
  expectedSlots: string[],
  produces: string[],
): Array<{ slot: string; artifactId: string }> {
  const canonical = canonicalSlotRecords(state, stageId, produces);
  const records = canonical.records;
  if (canonical.error) {
    return produces.map((artifactId) => ({ slot: "<any>", artifactId }));
  }
  const missing: Array<{ slot: string; artifactId: string }> = [];
  for (const artifactId of produces) {
    const contributors = expectedSlots.filter((slot) => slotArtifactRecord(records, slot, artifactId) !== undefined);
    if (contributors.length === 0) missing.push({ slot: "<any>", artifactId });
  }
  for (const slot of expectedSlots) {
    const recorded = Object.keys(records.slots[slot] ?? {}).length;
    if (recorded === 0) missing.push({ slot, artifactId: "<any>" });
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
}

/** A merged value plus the slot that authored it at this path (null = composite). */
interface MergedNode {
  value: unknown;
  origin: string | null;
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
  const entries: MergeEntry[] = values.map((value, index) => ({ slot: `slot-${index}`, value }));
  return mergeSlotEntries(entries, requiredFields, strict, artifactId, resolutions, new Date().toISOString());
}

function mergeSlotEntries(
  entries: MergeEntry[],
  requiredFields: string[] | null,
  strict: boolean,
  artifactId: string,
  resolutions: StageFanInResolution[],
  resolvedAt: string,
): MergeResult {
  if (entries.length === 0) return { ok: true, value: undefined };
  const conflicts: FanInConflictRecord[] = [];
  let merged: MergedNode = { value: entries[0]!.value, origin: entries[0]!.slot };
  for (const next of entries.slice(1)) {
    const step = mergePair(merged, next, requiredFields ?? [], strict, artifactId, "$", resolutions, conflicts, resolvedAt);
    if (!step.ok) return step;
    merged = step;
  }
  return { ok: true, value: merged.value, ...(conflicts.length > 0 ? { conflicts } : {}) };
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
): { ok: true; value: unknown; origin: string | null } | { ok: false; error: string } {
  const l = left.value;
  const r = right.value;
  if (JSON.stringify(l) === JSON.stringify(r)) {
    return { ok: true, value: l, origin: left.origin };
  }
  if (Array.isArray(l) && Array.isArray(r)) {
    const merged = [...l];
    for (const item of r) {
      if (!merged.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) merged.push(item);
    }
    return { ok: true, value: merged, origin: left.origin };
  }
  if (l && r && typeof l === "object" && typeof r === "object" && !Array.isArray(l) && !Array.isArray(r)) {
    const merged: Record<string, unknown> = { ...(l as Record<string, unknown>) };
    const origins = new Map<string, string | null>();
    for (const key of Object.keys(merged)) origins.set(key, left.origin);
    for (const [key, rightValue] of Object.entries(r as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(merged, key)) {
        merged[key] = rightValue;
        origins.set(key, right.slot);
        continue;
      }
      const step = mergePair(
        { value: merged[key], origin: origins.get(key) ?? left.origin },
        { slot: right.slot, value: rightValue },
        requiredFields,
        strict,
        artifactId,
        `${path}.${key}`,
        resolutions,
        conflicts,
        resolvedAt,
      );
      if (!step.ok) return step;
      merged[key] = step.value;
      origins.set(key, step.origin);
    }
    return {
      ok: true,
      value: merged,
      origin: [...origins.values()].find((origin) => origin !== null) ?? left.origin,
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
  // as a conflict because the schema does not require agreement here.
  return { ok: true, value: l, origin: left.origin };
}

export type SynthesisResult =
  | { ok: true; state: TeamState; shared: Record<string, { slots: string[]; synthesized_at: string; conflicts?: FanInConflictRecord[] }> }
  | { ok: false; error: string; state?: TeamState };

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
): SynthesisResult {
  if (!policy.enabled || expectedSlots.length <= 1) {
    return { ok: true, state, shared: {} };
  }
  const canonical = canonicalSlotRecords(state, stageId, produces);
  if (canonical.error) return { ok: false, error: canonical.error, state };
  const missing = missingSlotResults(state, stageId, expectedSlots, produces);
  if (missing.length > 0) {
    const detail = missing.map((entry) =>
      entry.slot === "<any>" ? `artifact '${entry.artifactId}' has no canonical receipt` : `slot '${entry.slot}' recorded no canonical artifact receipt`,
    ).join("; ");
    return { ok: false, error: `consilium fan-in incomplete: ${detail}`, state };
  }
  const records = canonical.records;
  const shared: NonNullable<StageSlotRecords["shared"]> = {};
  const now = new Date().toISOString();
  const resolutions = policy.resolutions ?? [];
  for (const artifactId of produces) {
    const contributors = expectedSlots.filter((slot) => slotArtifactRecord(records, slot, artifactId) !== undefined);
    const entries: MergeEntry[] = [];
    for (const slot of contributors) {
      const record = slotArtifactRecord(records, slot, artifactId)!;
      const raw = readArtifactFileSafe(artifactsDir, record.path);
      if (raw.status !== "present") {
        return { ok: false, error: `consilium fan-in: canonical immutable artifact '${artifactId}' for slot '${slot}' is unavailable`, state };
      }
      if (createHash("sha256").update(raw.bytes).digest("hex") !== record.hash) {
        return { ok: false, error: `consilium fan-in: canonical immutable artifact '${artifactId}' for slot '${slot}' failed hash verification`, state };
      }
      let value: unknown;
      try {
        value = JSON.parse(raw.bytes.toString("utf8")) as unknown;
      } catch {
        return { ok: false, error: `consilium fan-in: canonical immutable artifact '${artifactId}' for slot '${slot}' is not valid JSON`, state };
      }
      entries.push({ slot, value });
    }
    const merged = mergeSlotEntries(entries, requiredFieldsOf(artifactId), policy.strict, artifactId, resolutions, now);
    if (!merged.ok) return { ok: false, error: merged.error };
    writeArtifact(artifactsDir, artifactId, merged.value);
    const provenance: { slots: string[]; synthesized_at: string; conflicts?: FanInConflictRecord[] } = {
      slots: contributors,
      synthesized_at: now,
    };
    if (merged.conflicts && merged.conflicts.length > 0) provenance.conflicts = merged.conflicts;
    shared[artifactId] = provenance;
  }
  const stageRecords: StageSlotRecords = { ...records, shared: { ...(records.shared ?? {}), ...shared } };
  return {
    ok: true,
    state: { ...state, slot_artifacts: { ...(state.slot_artifacts ?? {}), [stageId]: stageRecords } },
    shared,
  };
}
