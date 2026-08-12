/**
 * CTO slice dispatch gate (architecture-3, architecture-7).
 *
 * Before a lead/worker is dispatched for a CTO slice, the canonical CtoState
 * must prove: the task call carries the routing marker for the run, an active
 * wave exists, the slice maps to a team, the team carries a full per-slice
 * classification (type/complexity/confidence/boolean autonomous), the
 * matrix-resolved workflow matches (resolveWorkflow — never re-derived from
 * text), and a readable non-empty per-slice DoD exists. Missing or mismatched
 * state blocks with an actionable reason; the marker is routing metadata ONLY
 * (the gate validates canonical state, not marker trust).
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
import { readDoD } from "../engine/dod.js";
import { resolveWorkflow } from "../engine/profile.js";
import type { ModelClassification } from "../engine/run.js";
import type { Complexity, Confidence, TaskType } from "../engine/types.js";
import { activeWave, readCtoState } from "./state.js";
import type { CtoState } from "./types.js";

/** Routing-marker prefix — a CTO slice task call carries `<!-- omp-cto-slice ... -->`. */
export const CTO_SLICE_MARKER_PREFIX = "<!-- omp-cto-slice";

const TASK_TYPES: readonly TaskType[] = ["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "REVIEW", "HOTFIX"];
const COMPLEXITIES: readonly Complexity[] = ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"];
const CONFIDENCES: readonly Confidence[] = ["HIGH", "MEDIUM", "LOW"];

/** Build the routing marker: `<!-- omp-cto-slice run=<runId> slice=<sliceId> -->`. */
export function buildCtoSliceMarker(runId: string, sliceId: string): string {
  return `${CTO_SLICE_MARKER_PREFIX} run=${runId} slice=${sliceId} -->`;
}

const SLICE_MARKER_RE = /<!--\s*omp-cto-slice\s+run=([A-Za-z0-9._-]+)\s+slice=([A-Za-z0-9._-]+)\s*-->/;

/**
 * Parse the routing marker out of a single-line text payload (e.g. the
 * JSON-serialized `task` tool input). runId/sliceId are slugs. No marker or
 * malformed marker → null.
 */
export function parseCtoSliceMarker(text: string): { runId: string; sliceId: string } | null {
  const m = SLICE_MARKER_RE.exec(text);
  if (!m) return null;
  return { runId: m[1] ?? "", sliceId: m[2] ?? "" };
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
  const expected = resolveWorkflow(classification.type, classification.complexity, classification.autonomous);
  if (typeof workflow === "string" && workflow === expected) return null;
  const got = typeof workflow === "string" ? workflow : JSON.stringify(workflow) ?? "missing";
  return `slice workflow mismatch: expected ${expected}, got ${got}`;
}

/**
 * Validate the per-slice DoD artifact. Resolves the DoD dir from the team's
 * `dod_path` (relative to root) when set, else the default
 * `.work-state/artifacts/<teamId>/`; readDoD must return non-null with
 * items.length > 0. Returns null when valid, else an actionable reason
 * (unknown team / unreadable / empty).
 */
export function validateSliceDoD(state: CtoState, teamId: string, root: string): string | null {
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) return `unknown team ${teamId}: no team record in run ${state.id}`;
  const dodDir = team.dod_path ? join(root, team.dod_path) : join(root, ".work-state", "artifacts", teamId);
  const dod = readDoD(dodDir);
  if (!dod) return `slice DoD unreadable: no dod.json at ${join(dodDir, "dod.json")}`;
  if (!Array.isArray(dod.items) || dod.items.length === 0) {
    return `slice DoD empty: ${join(dodDir, "dod.json")} has no items`;
  }
  return null;
}

/**
 * Fail-closed dispatch check for a CTO slice. Checks, in order, each with an
 * actionable reason:
 *   1. markerRunId (when provided) matches state.id;
 *   2. an active wave exists (active_wave_id set AND its wave_history record
 *      has status "active");
 *   3. the slice maps to a team (slice_id or id);
 *   4. the team's classification passes validateSliceClassification;
 *   5. the team's workflow passes validateSliceWorkflow;
 *   6. the team's per-slice DoD passes validateSliceDoD.
 */
export function assertCtoSliceDispatchable(
  state: CtoState,
  opts: { sliceId: string; root: string; markerRunId?: string },
): { ok: true } | { ok: false; reason: string } {
  // 1. marker run must match the canonical run
  if (opts.markerRunId !== undefined && opts.markerRunId !== state.id) {
    return { ok: false, reason: `marker run mismatch: expected ${state.id}, marker says ${opts.markerRunId}` };
  }
  // 2. an active wave is required — waves are the resident dispatch unit
  if (!state.active_wave_id) {
    return { ok: false, reason: `no active wave: active_wave_id is unset in run ${state.id}` };
  }
  const wave = (state.wave_history ?? []).find((w) => w.id === state.active_wave_id);
  if (!wave || wave.status !== "active") {
    return { ok: false, reason: `no active wave: wave ${state.active_wave_id} is not active in run ${state.id}` };
  }
  // 3. slice → team mapping (slice_id preferred, id fallback)
  const team = state.teams.find((t) => t.slice_id === opts.sliceId || t.id === opts.sliceId);
  if (!team) {
    return { ok: false, reason: `unknown slice ${opts.sliceId}: no team with slice_id or id matching in run ${state.id}` };
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
 * - `{ kind: "batch", items }` when `input.task` is not a string and
 *   `input.tasks` is an array (items carry per-item marker/attempted);
 * - `{ kind: "none" }` for every other input shape.
 * Marker text in input.context/i/agent/name/outputSchema/… never counts.
 */
function extractTaskMarkers(input: unknown): { kind: "single"; marker: SliceMarker | null; attempted: boolean } | { kind: "batch"; items: Array<{ marker: SliceMarker | null; attempted: boolean }> } | { kind: "none" } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { kind: "none" };
  const rec = input as Record<string, unknown>;
  if (typeof rec.task === "string") {
    const text = rec.task as string;
    const marker = parseCtoSliceMarker(text);
    return { kind: "single", marker, attempted: marker === null && text.includes(CTO_SLICE_MARKER_PREFIX) };
  }
  if (Array.isArray(rec.tasks)) {
    const items: Array<{ marker: SliceMarker | null; attempted: boolean }> = [];
    for (const item of rec.tasks) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).task === "string") {
        const text = (item as Record<string, unknown>).task as string;
        const marker = parseCtoSliceMarker(text);
        items.push({
          marker: marker ? { ...marker, item: items.length } : null,
          attempted: marker === null && text.includes(CTO_SLICE_MARKER_PREFIX),
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
 * non-null. Multiple active runs → the one with the latest `updated_at`
 * (deterministic). No active wave anywhere → null.
 */
function findActiveWave(root: string): { runId: string; waveId: string } | null {
  const ctoDir = join(root, ".work-state", "cto");
  if (!existsSync(ctoDir)) return null;
  let best: { runId: string; waveId: string; updatedAt: string } | null = null;
  for (const entry of readdirSync(ctoDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const state = readCtoState(entry.name, root);
    if (!state) continue; // unreadable/corrupt — skip
    const wave = activeWave(state);
    if (!wave) continue;
    if (!best || state.updated_at > best.updatedAt) {
      best = { runId: entry.name, waveId: wave.id, updatedAt: state.updated_at };
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
 * - Never throws: odd input falls back to the fail-safe allow in the catch.
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
      const missingIndex = parsed.items.findIndex((it) => it.marker === null);
      if (missingIndex !== -1) {
        const missing = parsed.items[missingIndex]!;
        const active = findActiveWave(ctx.cwd);
        return active ? { block: true, reason: noMarkerBlockReason(active, missing.attempted, missingIndex) } : undefined;
      }
      for (const it of parsed.items) {
        const marker = it.marker as SliceMarker;
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

    // No task payload at all — fail closed while a wave is active.
    const active = findActiveWave(ctx.cwd);
    return active ? { block: true, reason: noMarkerBlockReason(active, false, undefined) } : undefined;
  } catch {
    // fail-safe allow — the gate must never throw.
    return undefined;
  }
}
