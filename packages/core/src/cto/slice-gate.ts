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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readDoD } from "../engine/dod.js";
import { resolveWorkflow } from "../engine/profile.js";
import type { ModelClassification } from "../engine/run.js";
import type { Complexity, Confidence, DoD, TaskType } from "../engine/types.js";
import { activeWave, readCtoState } from "./state.js";
import type { CtoState } from "./types.js";
import { projectRuntimeKeyFor, isSafeCtoId, validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type { ProjectIdentity, WorkflowRunIdentity } from "../workflow-v2/types.js";

/** Routing-marker prefix — a CTO slice task call carries `<!-- omp-cto-slice ... -->`. */
export const CTO_SLICE_MARKER_PREFIX = "<!-- omp-cto-slice";

const MAX_MARKER_TEXT_LENGTH = 16_384;
const MAX_WORKFLOW_LABEL_LENGTH = 64;
const MAX_DOD_PATH_LENGTH = 512;
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

function resolveSafeDodDir(root: string, teamId: string, configuredPath: unknown): string | null {
  const candidate =
    configuredPath === undefined || configuredPath === ""
      ? join(".work-state", "artifacts", teamId)
      : configuredPath;
  if (
    typeof candidate !== "string" ||
    candidate.length > MAX_DOD_PATH_LENGTH ||
    candidate.includes("\0") ||
    isAbsolute(candidate) ||
    candidate.split(/[\\/]/).some((part) => part === "..")
  ) {
    return null;
  }
  const rootPath = resolve(root);
  const dodDir = resolve(rootPath, candidate);
  const outside = relative(rootPath, dodDir);
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) return null;
  return dodDir;
}

/**
 * Validate the per-slice DoD artifact. Resolves the DoD dir from the team's
 * `dod_path` (relative to root) when set, else the default
 * `.work-state/artifacts/<teamId>/`; readDoD must return non-null with
 * items.length > 0. Returns null when valid, else an actionable reason
 * (unknown team / unreadable / empty).
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
  const dodDir = resolveSafeDodDir(root, teamId, team.dod_path);
  if (!dodDir) return "slice DoD path invalid: configured dod_path is not a safe relative path";
  let dod: DoD | null;
  try {
    dod = readDoD(dodDir);
  } catch {
    dod = null;
  }
  if (!dod) return `slice DoD unreadable: no dod.json at ${join(dodDir, "dod.json")}`;
  if (!Array.isArray(dod.items)) {
    return `slice DoD unreadable: ${join(dodDir, "dod.json")} has invalid items`;
  }
  if (dod.items.length === 0) {
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
 *   3. the slice maps to exactly one team (slice_id or id) and is admitted
 *      by that active wave;
 *   4. the team's classification passes validateSliceClassification;
 *   5. the team's workflow passes validateSliceWorkflow;
 *   6. the team's per-slice DoD passes validateSliceDoD.
 */
function ctoRunIdentityKey(identity: WorkflowRunIdentity): string {
  return JSON.stringify([
    projectRuntimeKeyFor(identity),
    identity.run_id,
    identity.profile_identity.id,
    identity.profile_identity.fingerprint,
  ]);
}

export function assertCtoSliceDispatchable(
  state: CtoState,
  opts: { sliceId: string; root: string; markerRunId?: string; runIdentity: WorkflowRunIdentity },
): { ok: true } | { ok: false; reason: string } {
  if (!state || typeof state !== "object" || !isSafeCtoId(state.id)) {
    return { ok: false, reason: "invalid canonical CtoState: unsafe or missing run id" };
  }
  const stateRun = validateWorkflowRunIdentity((state as unknown as { run_identity?: unknown }).run_identity);
  const expectedRun = validateWorkflowRunIdentity(opts?.runIdentity);
  if (!stateRun.ok || !expectedRun.ok) {
    return {
      ok: false,
      reason: "MIGRATION_REQUIRED: CTO dispatch requires complete persisted and admitted WorkflowRunIdentity records",
    };
  }
  try {
    if (ctoRunIdentityKey(stateRun.value) !== ctoRunIdentityKey(expectedRun.value)) {
      return {
        ok: false,
        reason: `IDENTITY_MISMATCH: CTO state run ${displayCtoId(state.id)} is not bound to the admitted workflow run identity`,
      };
    }
  } catch {
    return { ok: false, reason: "MIGRATION_REQUIRED: CTO run identity could not be validated" };
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
 * Find the active CTO wave anywhere in the workspace. Raw bytes are used only
 * to discover a candidate run identity; `readCtoState` then validates the
 * complete state under that exact run identity before the wave is observed.
 * A project identity narrows discovery to its bound project, while a run
 * identity is required for authorization by the caller.
 */
function findActiveWave(
  root: string,
  expectedProjectIdentity?: ProjectIdentity,
  expectedRunIdentity?: WorkflowRunIdentity,
): { runId: string; waveId: string } | null {
  const ctoDir = join(root, ".work-state", "cto");
  if (!existsSync(ctoDir)) return null;
  let best: { runId: string; waveId: string; updatedAt: string } | null = null;
  for (const entry of readdirSync(ctoDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeCtoId(entry.name)) continue;
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(ctoDir, entry.name, "state.json"), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      raw = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (raw.id !== entry.name) continue;
    const checkedRun = validateWorkflowRunIdentity(raw.run_identity);
    if (!checkedRun.ok) continue;
    try {
      if (expectedProjectIdentity && projectRuntimeKeyFor(checkedRun.value) !== projectRuntimeKeyFor(expectedProjectIdentity)) continue;
      if (expectedRunIdentity && ctoRunIdentityKey(checkedRun.value) !== ctoRunIdentityKey(expectedRunIdentity)) continue;
    } catch {
      continue;
    }
    const state = readCtoState(entry.name, root, checkedRun.value);
    if (!state) continue;
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

interface ActiveWaveRouting {
  runId: string;
  waveId: string;
  /** True only when the exact admitted run identity authorized observation. */
  identityMatched: boolean;
}

/**
 * Resolve a wave for no-marker routing without granting raw state authority.
 * Project identity narrows discovery, but only the exact run identity can
 * authorize a dispatch.
 */
function findActiveWaveForRouting(
  root: string,
  expectedProjectIdentity?: ProjectIdentity,
  expectedRunIdentity?: WorkflowRunIdentity,
): ActiveWaveRouting | null {
  if (expectedRunIdentity) {
    const bound = findActiveWave(root, expectedProjectIdentity, expectedRunIdentity);
    if (bound) return { ...bound, identityMatched: true };
  }
  const observed = findActiveWave(root, expectedProjectIdentity);
  if (observed) return { ...observed, identityMatched: false };
  const raw = findActiveWave(root);
  return raw ? { ...raw, identityMatched: false } : null;
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

/** Block a marker-bearing call when the host did not provide the v2 identity. */
function identityRequiredForMarker(runId: string, sliceId: string, item: number | undefined): string {
  const where = item !== undefined ? ` (batch task item ${item})` : "";
  return `cto slice gate: MIGRATION_REQUIRED — workflow identity is required to dispatch CTO slice ${sliceId} for run ${runId}${where}; refusing legacy or unbound CTO routing`;
}

/** Block legacy/no-marker routing when an active wave cannot be identity-bound. */
function identityRequiredForActiveWave(active: { runId: string; waveId: string }, item: number | undefined): string {
  const where = item !== undefined ? ` (batch task item ${item})` : "";
  return `cto slice gate: MIGRATION_REQUIRED — workflow identity is required to route active wave ${active.waveId} in run ${active.runId}${where}; refusing legacy or unbound CTO routing`;
}

/** Raw-only presence is a security guard: it can report identity drift, never authorize dispatch. */
function identityMismatchForActiveWave(active: ActiveWaveRouting, item: number | undefined): string {
  const where = item !== undefined ? ` (batch task item ${item})` : "";
  return `cto slice gate: IDENTITY_MISMATCH — MIGRATION_REQUIRED: active wave ${active.waveId} in run ${active.runId}${where} is not bound to the admitted workflow identity; migrate the persisted state or start a fresh CTO lifecycle before routing work`;
}

/** Return the identity failure for raw/missing-context active-wave observations. */
function activeWaveIdentityBlockReason(
  active: ActiveWaveRouting,
  expectedProjectIdentity: ProjectIdentity | undefined,
  expectedRunIdentity: WorkflowRunIdentity | undefined,
  item: number | undefined,
): string | undefined {
  if (!expectedProjectIdentity || !expectedRunIdentity) return identityRequiredForActiveWave(active, item);
  if (!active.identityMatched) return identityMismatchForActiveWave(active, item);
  return undefined;
}

/** Preserve the actionable path while identifying an unbound/mismatched state. */
function noCtoStateBlockReason(runId: string, sliceId: string, item: number | undefined): string {
  const where = item !== undefined ? ` (batch task item ${item})` : "";
  return `no CtoState for run ${runId} at .work-state/cto/${runId}/state.json — cannot dispatch CTO slice ${sliceId}${where}; MIGRATION_REQUIRED: admitted workflow identity is required and must match persisted state`;
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
 *   dir, non-CTO projects) → undefined (allow). If only a raw wave is
 *   observable, it is reported as an identity mismatch and never authorizes
 *   dispatch.
 * - VALID marker present → the canonical CtoState for marker.runId is loaded
 *   with the admitted v2 identity; missing, mismatched, or unbound identity
 *   blocks with MIGRATION_REQUIRED rather than dispatching.
 *   assertCtoSliceDispatchable then decides; unreadable state with a clearly
 *   present marker blocks ("no CtoState ... cannot dispatch CTO slice").
 *   Batches validate EVERY item: the first item without a valid marker takes
 *   the fail-closed path (blocked when an active wave exists, item named); a
 *   batch is allowed only when every item's marker passes canonical
 *   validation (first failing item blocks with its run/slice named).
 * - Active-wave discovery first attempts the context-bound identity. A raw
 *   active wave found without a matching context identity blocks with
 *   MIGRATION_REQUIRED/IDENTITY_MISMATCH instead of allowing legacy routing;
 *   no active wave still preserves the ordinary no-marker allow path.
 * - Malformed input or state errors fail closed and block the task launch.
 */
export function ctoSliceTaskGate(
  event: { toolName?: string; input?: unknown },
  ctx: { cwd: string; project_identity?: ProjectIdentity; run_identity?: WorkflowRunIdentity },
): { block: true; reason: string } | undefined {
  try {
    if (event?.toolName !== "task") return undefined;

    let projectIdentity: ProjectIdentity | undefined;
    let runIdentity: WorkflowRunIdentity | undefined;
    let contextIdentityMismatch = false;
    const projectResult = validateProjectIdentity(ctx?.project_identity);
    if (projectResult.ok) projectIdentity = projectResult.value;
    const runResult = validateWorkflowRunIdentity(ctx?.run_identity);
    if (runResult.ok) runIdentity = runResult.value;
    if (projectIdentity && runIdentity) {
      try {
        contextIdentityMismatch = projectRuntimeKeyFor(projectIdentity) !== projectRuntimeKeyFor(runIdentity);
      } catch {
        contextIdentityMismatch = true;
      }
    }

    const parsed = extractTaskMarkers(event.input);

    const activeReason = (
      active: ActiveWaveRouting,
      item: number | undefined,
    ): string | undefined => {
      if (contextIdentityMismatch) {
        const where = item !== undefined ? ` (batch task item ${item})` : "";
        return `cto slice gate: IDENTITY_MISMATCH — admitted project identity does not match the supplied workflow run identity${where}`;
      }
      return activeWaveIdentityBlockReason(active, projectIdentity, runIdentity, item);
    };

    if (parsed.kind === "single") {
      if (!parsed.marker) {
        const active = findActiveWaveForRouting(ctx.cwd, projectIdentity, runIdentity);
        if (!active) return undefined;
        const identityReason = activeReason(active, undefined);
        if (identityReason) return { block: true, reason: identityReason };
        return { block: true, reason: noMarkerBlockReason(active, parsed.attempted, undefined) };
      }
      if (contextIdentityMismatch) {
        return {
          block: true,
          reason: `cto slice gate: IDENTITY_MISMATCH — admitted project identity does not match the supplied workflow run identity for CTO slice ${parsed.marker.sliceId}`,
        };
      }
      if (!projectIdentity || !runIdentity) {
        return { block: true, reason: identityRequiredForMarker(parsed.marker.runId, parsed.marker.sliceId, undefined) };
      }
      const state = readCtoState(parsed.marker.runId, ctx.cwd, runIdentity);
      if (!state) {
        return {
          block: true,
          reason: noCtoStateBlockReason(parsed.marker.runId, parsed.marker.sliceId, undefined),
        };
      }
      const res = assertCtoSliceDispatchable(state, {
        sliceId: parsed.marker.sliceId,
        root: ctx.cwd,
        markerRunId: parsed.marker.runId,
        runIdentity,
      });
      if (!res.ok) return { block: true, reason: `cto slice gate: ${res.reason}` };
      return undefined;
    }

    if (parsed.kind === "batch") {
      if (parsed.items.length === 0) {
        const active = findActiveWaveForRouting(ctx.cwd, projectIdentity, runIdentity);
        if (!active) return undefined;
        const identityReason = activeReason(active, undefined);
        if (identityReason) return { block: true, reason: identityReason };
        return { block: true, reason: noMarkerBlockReason(active, false, undefined) };
      }
      const missingIndex = parsed.items.findIndex((item) => item.marker === null);
      const activeForMissing = missingIndex >= 0
        ? findActiveWaveForRouting(ctx.cwd, projectIdentity, runIdentity)
        : null;
      if (missingIndex >= 0 && !activeForMissing) return undefined;
      for (let index = 0; index < parsed.items.length; index += 1) {
        const item = parsed.items[index]!;
        if (!item.marker) {
          if (activeForMissing) {
            const identityReason = activeReason(activeForMissing, index);
            if (identityReason) return { block: true, reason: identityReason };
            return { block: true, reason: noMarkerBlockReason(activeForMissing, item.attempted, index) };
          }
          continue;
        }
        const marker = item.marker;
        if (contextIdentityMismatch) {
          return {
            block: true,
            reason: `cto slice gate: IDENTITY_MISMATCH — admitted project identity does not match the supplied workflow run identity for CTO slice ${marker.sliceId} (batch task item ${marker.item})`,
          };
        }
        if (!projectIdentity || !runIdentity) {
          return { block: true, reason: identityRequiredForMarker(marker.runId, marker.sliceId, index) };
        }
        const state = readCtoState(marker.runId, ctx.cwd, runIdentity);
        if (!state) {
          return {
            block: true,
            reason: noCtoStateBlockReason(marker.runId, marker.sliceId, marker.item),
          };
        }
        const res = assertCtoSliceDispatchable(state, {
          sliceId: marker.sliceId,
          root: ctx.cwd,
          markerRunId: marker.runId,
          runIdentity,
        });
        if (!res.ok) return { block: true, reason: `cto slice gate: ${res.reason} (batch task item ${marker.item})` };
      }
      return undefined;
    }

    if (parsed.kind === "ambiguous") {
      const active = findActiveWaveForRouting(ctx.cwd, projectIdentity, runIdentity);
      if (!active) return undefined;
      const identityReason = activeReason(active, undefined);
      if (identityReason) return { block: true, reason: identityReason };
      return {
        block: true,
        reason: `cto slice gate: active wave ${active.waveId} in run ${active.runId} — ambiguous task payload has both task and tasks fields; provide exactly one marker-bearing shape or fold the work into the wave`,
      };
    }

    // No task payload at all — fail closed while a wave is active.
    const active = findActiveWaveForRouting(ctx.cwd, projectIdentity, runIdentity);
    if (!active) return undefined;
    const identityReason = activeReason(active, undefined);
    if (identityReason) return { block: true, reason: identityReason };
    return { block: true, reason: noMarkerBlockReason(active, false, undefined) };
  } catch {
    return { block: true, reason: "cto slice gate: malformed dispatch input or unreadable state — refusing task launch" };
  }
}
