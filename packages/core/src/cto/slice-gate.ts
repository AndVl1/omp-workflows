/**
 * CTO slice dispatch gate (architecture-3, architecture-7).
 *
 * Before a lead/worker is dispatched for a CTO slice, the canonical CtoState
 * must prove: the task call carries the exact routing marker for the run, an
 * active wave exists and admits the slice, that slice maps to exactly one
 * team, the team carries a full per-slice classification
 * (type/complexity/confidence/boolean autonomous), the matrix-resolved
 * workflow matches (resolveWorkflow — never re-derived from text), and a
 * readable non-empty per-slice DoD exists. Missing or mismatched state blocks
 * with an actionable reason; the marker is routing metadata ONLY (the gate
 * validates canonical state, not marker trust).
 *
 * Fail-closed for task tool calls during an active CTO wave (static-3): the
 * marker is read ONLY from the task payload field(s) — `input.task` (string)
 * or each `input.tasks[i].task` (string); marker text anywhere else does not
 * count. A task call with no VALID marker while any run under
 * `.work-state/cto/` has an active wave is blocked with the run id, the wave
 * id and the required marker format. Standby/no-wave runs and ordinary
 * non-CTO flows keep the allow path; the marker is routing metadata only, so
 * calls that do carry a marker are decided by canonical state validation.
 *
 * This gate runs AFTER ctoNestingGuard (untouched, still first) and never
 * weakens the nested-CTO prohibition.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readDoDFile, resolveDodPath } from "../engine/dod.js";
import { resolveWorkflow } from "../engine/profile.js";
import type { ModelClassification } from "../engine/run.js";
import type { Complexity, Confidence, TaskType } from "../engine/types.js";
import { activeWave, readCtoState } from "./state.js";
import type { CtoState } from "./types.js";

/** Routing-marker prefix — a CTO slice task call carries `<!-- omp-cto-slice ... -->`. */
export const CTO_SLICE_MARKER_PREFIX = "<!-- omp-cto-slice";

const MAX_MARKER_TEXT_LENGTH = 16_384;
const MAX_CTO_ID_LENGTH = 128;
const MAX_WORKFLOW_LABEL_LENGTH = 64;
const SAFE_CTO_ID_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_WORKFLOW_LABEL_RE = /^[A-Za-z0-9_-]+$/;

const TASK_TYPES: readonly TaskType[] = ["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "REVIEW", "HOTFIX", "PRODUCT_DISCOVERY"];
const COMPLEXITIES: readonly Complexity[] = ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"];
const CONFIDENCES: readonly Confidence[] = ["HIGH", "MEDIUM", "LOW"];

/** Build the routing marker: `<!-- omp-cto-slice run=<runId> slice=<sliceId> -->`. */
export function buildCtoSliceMarker(runId: string, sliceId: string): string {
  return `${CTO_SLICE_MARKER_PREFIX} run=${runId} slice=${sliceId} -->`;
}

const SLICE_MARKER_RE = /<!-- omp-cto-slice run=([A-Za-z0-9._-]{1,128}) slice=([A-Za-z0-9._-]{1,128}) -->/;
const SLICE_MARKER_GLOBAL_RE = /<!-- omp-cto-slice run=([A-Za-z0-9._-]{1,128}) slice=([A-Za-z0-9._-]{1,128}) -->/g;
const MARKER_ATTEMPT_RE = /<!--\s*omp-cto-slice/;
const MARKER_ATTEMPT_GLOBAL_RE = /<!--\s*omp-cto-slice/g;

function isSafeCtoId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CTO_ID_LENGTH &&
    value !== "." &&
    value !== ".." &&
    SAFE_CTO_ID_RE.test(value)
  );
}

function markerPrefixAttempted(text: string): boolean {
  if (text.length > MAX_MARKER_TEXT_LENGTH) return false;
  return MARKER_ATTEMPT_RE.test(text);
}

function markerPrefixCount(text: string): number {
  const matches = text.match(MARKER_ATTEMPT_GLOBAL_RE);
  return matches ? matches.length : 0;
}

function displayCtoId(value: unknown): string {
  if (isSafeCtoId(value)) return value;
  return "<invalid>";
}

function ownTaskText(value: unknown): string | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.prototype.hasOwnProperty.call(value, "task") ||
    !("task" in value)
  ) {
    return null;
  }
  const task = value.task;
  return typeof task === "string" ? task : null;
}

/**
 * Parse the routing marker out of a bounded text payload (e.g. the
 * JSON-serialized `task` tool input). runId/sliceId are safe slugs. Exactly
 * one exact-format marker is accepted; no marker or malformed/ambiguous
 * marker → null.
 */
export function parseCtoSliceMarker(text: string): { runId: string; sliceId: string } | null {
  if (typeof text !== "string" || text.length > MAX_MARKER_TEXT_LENGTH) return null;
  if (markerPrefixCount(text) !== 1) return null;
  const match = SLICE_MARKER_RE.exec(text);
  const runId = match?.[1];
  const sliceId = match?.[2];
  if (!isSafeCtoId(runId) || !isSafeCtoId(sliceId)) return null;
  const matches = text.match(SLICE_MARKER_GLOBAL_RE);
  if (!matches || matches.length !== 1) return null;
  return { runId, sliceId };
}

/**
 * Validate a per-slice classification: type ∈ TaskType, complexity ∈
 * Complexity, confidence ∈ Confidence, autonomous is boolean. Returns null
 * when valid, else a reason listing EXACTLY which fields are
 * missing/invalid. Fail-closed: non-object input lists all four.
 */
export function validateSliceClassification(value: unknown): string | null {
  const problems: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "slice classification invalid: type (missing), complexity (missing), confidence (missing), autonomous (missing) — expected an object";
  }
  const c = value as Record<string, unknown>;
  if (!TASK_TYPES.includes(c.type as TaskType)) problems.push(`type (${c.type === undefined ? "missing" : "invalid"})`);
  if (!COMPLEXITIES.includes(c.complexity as Complexity)) problems.push(`complexity (${c.complexity === undefined ? "missing" : "invalid"})`);
  if (!CONFIDENCES.includes(c.confidence as Confidence)) problems.push(`confidence (${c.confidence === undefined ? "missing" : "invalid"})`);
  if (typeof c.autonomous !== "boolean") problems.push(`autonomous (${c.autonomous === undefined ? "missing" : "invalid"})`);
  return problems.length > 0 ? `slice classification invalid: ${problems.join(", ")}` : null;
}

/**
 * Validate the persisted per-slice workflow against the matrix: it must be a
 * string equal to resolveWorkflow(type, complexity, autonomous). Returns null
 * when valid, else a reason including the expected workflow name. Callers
 * must have validated the classification first (the gate checks it in order).
 */
export function validateSliceWorkflow(classification: ModelClassification, workflow: unknown): string | null {
  const classificationError = validateSliceClassification(classification);
  if (classificationError) return classificationError;
  const expected = resolveWorkflow(classification.type, classification.complexity, classification.autonomous);
  if (typeof workflow === "string" && workflow === expected) return null;
  let got = "invalid";
  if (workflow === undefined) {
    got = "missing";
  } else if (
    typeof workflow === "string" &&
    workflow.length <= MAX_WORKFLOW_LABEL_LENGTH &&
    SAFE_WORKFLOW_LABEL_RE.test(workflow)
  ) {
    got = workflow;
  }
  return `slice workflow mismatch: expected ${expected}, got ${got}`;
}

/**
 * Validate the per-slice DoD artifact. Resolves the DoD FILE from the team's
 * `dod_path` via the canonical resolver — either a directory containing
 * dod.json or the dod.json file itself (relative to root; default
 * `.work-state/artifacts/<teamId>/`) — then it must parse with items.length
 * > 0. Returns null when valid, else an actionable reason (unknown team /
 * unsafe path / unreadable with resolved path + cause / empty).
 */
export function validateSliceDoD(state: CtoState, teamId: string, root: string): string | null {
  if (!isSafeCtoId(teamId)) return "unsafe team id: refusing to resolve a slice DoD path";
  if (!state || typeof state !== "object" || !Array.isArray(state.teams)) {
    return "slice DoD unreadable: CtoState has no team records";
  }
  if (typeof root !== "string" || root.length === 0) {
    return "slice DoD path invalid: dispatch root is missing";
  }
  const team = state.teams.find((t) => t && t.id === teamId);
  if (!team) return `unknown team ${teamId}: no team record in run ${displayCtoId(state.id)}`;
  const resolved = resolveDodPath(root, team.dod_path, teamId);
  if (!resolved.ok) return `slice DoD path invalid: ${resolved.reason}`;
  const read = readDoDFile(resolved.file, { root });
  if (!read.ok) return `slice DoD unreadable: ${read.reason}`;
  if (!Array.isArray(read.dod.items)) {
    return `slice DoD unreadable: ${resolved.file} has invalid items`;
  }
  if (read.dod.items.length === 0) {
    return `slice DoD empty: ${resolved.file} has no items`;
  }
  return null;
}

/**
 * Fail-closed dispatch check for a CTO slice. Checks, in order, each with an
 * actionable reason:
 *   1. markerRunId (when provided) matches state.id;
 *   2. an active wave exists (active_wave_id set AND its wave_history record
 *      has status "active");
 *   3. the slice maps to exactly one team (slice_id or id) and is admitted
 *      by that active wave;
 *   4. the team's classification passes validateSliceClassification;
 *   5. the team's workflow passes validateSliceWorkflow;
 *   6. the team's per-slice DoD passes validateSliceDoD.
 */
export function assertCtoSliceDispatchable(
  state: CtoState,
  opts: { sliceId: string; root: string; markerRunId?: string },
): { ok: true } | { ok: false; reason: string } {
  if (!state || typeof state !== "object" || !isSafeCtoId(state.id)) {
    return { ok: false, reason: "invalid canonical CtoState: unsafe or missing run id" };
  }
  if (!opts || typeof opts !== "object" || !isSafeCtoId(opts.sliceId)) {
    return { ok: false, reason: "unsafe slice id: refusing CTO slice dispatch" };
  }
  if (typeof opts.root !== "string" || opts.root.length === 0) {
    return { ok: false, reason: "invalid dispatch root: refusing CTO slice dispatch" };
  }
  // 1. marker run must match the canonical run
  if (opts.markerRunId !== undefined) {
    if (!isSafeCtoId(opts.markerRunId)) {
      return { ok: false, reason: "unsafe marker run id: refusing CTO slice dispatch" };
    }
    if (opts.markerRunId !== state.id) {
      return { ok: false, reason: `marker run mismatch: expected ${state.id}, marker says ${opts.markerRunId}` };
    }
  }
  // 2. an active wave is required — waves are the resident dispatch unit
  if (!isSafeCtoId(state.active_wave_id)) {
    return {
      ok: false,
      reason: state.active_wave_id
        ? `no active wave: unsafe active_wave_id in run ${state.id}`
        : `no active wave: active_wave_id is unset in run ${state.id}`,
    };
  }
  const wave = Array.isArray(state.wave_history)
    ? state.wave_history.find((w) => w && w.id === state.active_wave_id)
    : undefined;
  if (!wave || wave.status !== "active" || !isSafeCtoId(wave.id)) {
    return { ok: false, reason: `no active wave: wave ${displayCtoId(state.active_wave_id)} is not active in run ${state.id}` };
  }
  // 3. slice → exactly one team mapping (slice_id preferred, id fallback)
  if (!Array.isArray(state.teams)) {
    return { ok: false, reason: `unknown slice ${opts.sliceId}: CtoState has no team records in run ${state.id}` };
  }
  const matches = state.teams.filter((t) => t && (t.slice_id === opts.sliceId || t.id === opts.sliceId));
  if (matches.length === 0) {
    return { ok: false, reason: `unknown slice ${opts.sliceId}: no team with slice_id or id matching in run ${state.id}` };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous slice ${opts.sliceId}: multiple teams claim the slice in run ${state.id}` };
  }
  const team = matches[0]!;
  if (!isSafeCtoId(team.id)) {
    return { ok: false, reason: "unsafe team id: refusing CTO slice dispatch" };
  }
  const waveSliceIds = wave.slice_ids;
  if (
    !Array.isArray(waveSliceIds) ||
    waveSliceIds.some((sliceId) => !isSafeCtoId(sliceId)) ||
    waveSliceIds.filter((sliceId) => sliceId === opts.sliceId).length !== 1
  ) {
    return {
      ok: false,
      reason: `slice ${opts.sliceId} is not uniquely admitted by active wave ${wave.id} in run ${state.id}`,
    };
  }
  // 4. per-slice PHASE-0 classification must be complete
  const clsErr = validateSliceClassification(team.classification);
  if (clsErr) return { ok: false, reason: `${clsErr} for slice ${opts.sliceId} (team ${team.id})` };
  // 5. persisted workflow must match the matrix (classification validated above)
  const wfErr = validateSliceWorkflow(team.classification as ModelClassification, team.workflow);
  if (wfErr) return { ok: false, reason: `${wfErr} for slice ${opts.sliceId} (team ${team.id})` };
  // 6. per-slice DoD must be structurally present before any worker spawn
  const dodErr = validateSliceDoD(state, team.id, opts.root);
  if (dodErr) return { ok: false, reason: `${dodErr} for slice ${opts.sliceId}` };
  return { ok: true };
}


/** A routing marker parsed from a task payload (item = batch index, when batch). */
interface SliceMarker {
  runId: string;
  sliceId: string;
  item?: number;
}

/**
 * Extract routing markers from the task payload field(s) ONLY — never from
 * the whole serialized input. `input.task` (string) is the single shape;
 * each `input.tasks[i].task` (string) is the batch shape. Returns:
 * - `{ kind: "single", marker, attempted }` when `input.task` is a string;
 * - `{ kind: "batch", items }` when `input.tasks` is an array without a
 *   competing `task` field (items carry per-item marker/attempted);
 * - `{ kind: "ambiguous" }` when both task shapes are present;
 * - `{ kind: "none" }` for every other input shape.
 * Marker text in input.context/i/agent/name/outputSchema/… never counts.
 */
function extractTaskMarkers(
  input: unknown,
):
  | { kind: "single"; marker: SliceMarker | null; attempted: boolean }
  | { kind: "batch"; items: Array<{ marker: SliceMarker | null; attempted: boolean }> }
  | { kind: "ambiguous" }
  | { kind: "none" } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { kind: "none" };
  const rec = input as Record<string, unknown>;
  const hasTaskField = Object.prototype.hasOwnProperty.call(rec, "task");
  const hasTasksField = Object.prototype.hasOwnProperty.call(rec, "tasks");
  if (hasTaskField && hasTasksField) return { kind: "ambiguous" };
  if (hasTaskField && typeof rec.task === "string") {
    const text = rec.task;
    const marker = parseCtoSliceMarker(text);
    return { kind: "single", marker, attempted: marker === null && markerPrefixAttempted(text) };
  }
  if (hasTasksField && Array.isArray(rec.tasks)) {
    const items: Array<{ marker: SliceMarker | null; attempted: boolean }> = [];
    for (const item of rec.tasks) {
      const text = ownTaskText(item);
      if (text !== null) {
        const marker = parseCtoSliceMarker(text);
        items.push({
          marker: marker ? { ...marker, item: items.length } : null,
          attempted: marker === null && markerPrefixAttempted(text),
        });
      } else {
        items.push({ marker: null, attempted: false });
      }
    }
    return { kind: "batch", items };
  }
  return { kind: "none" };
}

/**
 * Find the active CTO wave anywhere in the workspace: scan
 * `<root>/.work-state/cto/<runId>/state.json` (guarded by existsSync;
 * unreadable/corrupt state skipped) for a run whose activeWave() is
 * non-null. Multiple active runs → the one with the latest `updated_at`,
 * breaking ties by run id. No active wave anywhere → null.
 */
function findActiveWave(root: string): { runId: string; waveId: string } | null {
  const ctoDir = join(root, ".work-state", "cto");
  if (!existsSync(ctoDir)) return null;
  let best: { runId: string; waveId: string; updatedAt: string } | null = null;
  for (const entry of readdirSync(ctoDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeCtoId(entry.name)) continue;
    const state = readCtoState(entry.name, root);
    if (!state) continue; // unreadable/corrupt — skip
    const wave = activeWave(state);
    if (!wave) continue;
    const waveId = isSafeCtoId(wave.id) ? wave.id : "<invalid>";
    const updatedAt = typeof state.updated_at === "string" ? state.updated_at.slice(0, 64) : "";
    if (
      !best ||
      updatedAt > best.updatedAt ||
      (updatedAt === best.updatedAt && entry.name > best.runId)
    ) {
      best = { runId: entry.name, waveId, updatedAt };
    }
  }
  return best ? { runId: best.runId, waveId: best.waveId } : null;
}

/** Block reason for a task call whose payload carries no VALID marker. */
function noMarkerBlockReason(active: { runId: string; waveId: string }, attempted: boolean, item: number | undefined): string {
  const expected = `<!-- omp-cto-slice run=${active.runId} slice=<sliceId> -->`;
  const where = item !== undefined ? ` (batch task item ${item})` : "";
  if (attempted) {
    return `cto slice gate: active wave ${active.waveId} in run ${active.runId} — task payload${where} carries a malformed CTO slice marker; expected "${expected}" (both run and slice attributes required) or fold the work into the wave`;
  }
  return `cto slice gate: active wave ${active.waveId} in run ${active.runId} — task tool call without a CTO slice marker${where}; add "${expected}" to the task payload or fold the work into the wave`;
}

/**
 * `tool_call` gate wired into the chain AFTER classificationToolGate and
 * BEFORE safetyGuard (ctoNestingGuard stays first and untouched).
 *
 * - event.toolName !== "task" → undefined (allow).
 * - The routing marker is extracted ONLY from the task payload field(s):
 *   `input.task` (string) for the single shape, or each `input.tasks[i].task`
 *   (string) for the batch shape. Marker text in any other field does NOT
 *   count as a valid marker.
 * - No VALID marker → fail-closed when any run under `<cwd>/.work-state/cto/`
 *   has an active wave (activeWave non-null; multiple runs → latest
 *   `updated_at`): the call blocks with the run id, the wave id and the
 *   required marker format. A payload that attempts the marker prefix but
 *   fails parseCtoSliceMarker blocks with the expected format named. No
 *   active wave anywhere (standby runs, finished waves, no .work-state/cto
 *   dir, non-CTO projects) → undefined (allow).
 * - VALID marker present → the canonical CtoState for marker.runId is loaded
 *   and assertCtoSliceDispatchable decides; unreadable state with a clearly
 *   present marker blocks ("no CtoState ... cannot dispatch CTO slice").
 *   Batches validate EVERY item: the first item without a valid marker takes
 *   the fail-closed path (blocked when an active wave exists, item named); a
 *   batch is allowed only when every item's marker passes canonical
 *   validation (first failing item blocks with its run/slice named).
 * - Malformed input or state errors fail closed and block the task launch.
 */
export function ctoSliceTaskGate(
  event: { toolName?: string; input?: unknown },
  ctx: { cwd: string },
): { block: true; reason: string } | undefined {
  try {
    if (event?.toolName !== "task") return undefined;

    const parsed = extractTaskMarkers(event.input);

    if (parsed.kind === "single") {
      if (!parsed.marker) {
        const active = findActiveWave(ctx.cwd);
        return active ? { block: true, reason: noMarkerBlockReason(active, parsed.attempted, undefined) } : undefined;
      }
      const state = readCtoState(parsed.marker.runId, ctx.cwd);
      if (!state) {
        return {
          block: true,
          reason: `no CtoState for run ${parsed.marker.runId} at .work-state/cto/${parsed.marker.runId}/state.json — cannot dispatch CTO slice ${parsed.marker.sliceId}`,
        };
      }
      const res = assertCtoSliceDispatchable(state, { sliceId: parsed.marker.sliceId, root: ctx.cwd, markerRunId: parsed.marker.runId });
      if (!res.ok) return { block: true, reason: `cto slice gate: ${res.reason}` };
      return undefined;
    }

    if (parsed.kind === "batch") {
      if (parsed.items.length === 0) {
        const active = findActiveWave(ctx.cwd);
        return active ? { block: true, reason: noMarkerBlockReason(active, false, undefined) } : undefined;
      }
      const missingIndex = parsed.items.findIndex((item) => item.marker === null);
      const activeForMissing = missingIndex >= 0 ? findActiveWave(ctx.cwd) : null;
      if (missingIndex >= 0 && !activeForMissing) return undefined;
      for (let index = 0; index < parsed.items.length; index += 1) {
        const item = parsed.items[index]!;
        if (!item.marker) {
          if (activeForMissing) return { block: true, reason: noMarkerBlockReason(activeForMissing, item.attempted, index) };
          continue;
        }
        const marker = item.marker;
        const state = readCtoState(marker.runId, ctx.cwd);
        if (!state) {
          return {
            block: true,
            reason: `no CtoState for run ${marker.runId} at .work-state/cto/${marker.runId}/state.json — cannot dispatch CTO slice ${marker.sliceId} (batch task item ${marker.item})`,
          };
        }
        const res = assertCtoSliceDispatchable(state, { sliceId: marker.sliceId, root: ctx.cwd, markerRunId: marker.runId });
        if (!res.ok) return { block: true, reason: `cto slice gate: ${res.reason} (batch task item ${marker.item})` };
      }
      return undefined;
    }

    if (parsed.kind === "ambiguous") {
      const active = findActiveWave(ctx.cwd);
      if (!active) return undefined;
      return {
        block: true,
        reason: `cto slice gate: active wave ${active.waveId} in run ${active.runId} — ambiguous task payload has both task and tasks fields; provide exactly one marker-bearing shape or fold the work into the wave`,
      };
    }

    // No task payload at all — fail closed while a wave is active.
    const active = findActiveWave(ctx.cwd);
    return active ? { block: true, reason: noMarkerBlockReason(active, false, undefined) } : undefined;
  } catch {
    return { block: true, reason: "cto slice gate: malformed dispatch input or unreadable state — refusing task launch" };
  }
}
