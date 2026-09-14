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

import { readDoDFilePinned, resolveDodPath } from "../engine/dod.js";
import { canonicalCtoDoDDigest } from "./dod.js";
import { PinnedProjectRoot } from "../specification/pinned-root.js";
import { isLiveExecutionClaim, readCurrentExecutionClaim } from "../specification/claims.js";
import { isSafeFeatureId, isSafeRelativePath, isSha256Hex } from "../specification/validation.js";
import { readPinnedCtoMappingRecord } from "../specification/mapping-record.js";
import { parseDispatchMarker } from "../gates/dispatch.js";
import { resolveWorkflow } from "../engine/profile.js";
import { MAX_PERSISTED_STATE_BYTES, normalizePersistedState, parseBoundedPersistedState } from "../engine/state.js";
import type { ModelClassification } from "../engine/run.js";
import type { Complexity, Confidence, TaskType, TeamState } from "../engine/types.js";
import { activeWave, ctoRunDeliverySummaryDigest, isSafeCtoExecutionId, readCtoRunDeliveryIndexAuthorityPinned, readCtoStatePinned, readCtoRunDeliveryReconciledActiveCandidatesPinned } from "./state.js";
import type { CtoState } from "./types.js";
import { CTO_SLICE_MARKER_PREFIX, buildCtoSliceMarker } from "./slice-marker.js";
export { CTO_SLICE_MARKER_PREFIX, buildCtoSliceMarker } from "./slice-marker.js";

/** Native task-tool consilium batches are capped at 32 task calls. */
const MAX_TASK_BATCH_ITEMS = 32;
/** Keep marker parsing bounded by the task-tool's UTF-8 text budget. */
const MAX_MARKER_TEXT_BYTES = 16 * 1024;
const MAX_CTO_ID_LENGTH = 128;
const MAX_WORKFLOW_LABEL_LENGTH = 64;
const SAFE_CTO_ID_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_WORKFLOW_LABEL_RE = /^[A-Za-z0-9_-]+$/;

const TASK_TYPES: readonly TaskType[] = ["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "LECTURE_RESEARCH", "REVIEW", "HOTFIX", "PRODUCT_DISCOVERY"];
const COMPLEXITIES: readonly Complexity[] = ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"];
const CONFIDENCES: readonly Confidence[] = ["HIGH", "MEDIUM", "LOW"];


type AdmissionFeatureStateRead =
  | { ok: true; state: TeamState; raw: Record<string, unknown> }
  | { ok: false; reason: string };

function readAdmissionFeatureState(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
): AdmissionFeatureStateRead {
  const relativePath = `.work-state/features/${featureId}/state.json`;
  try {
    const read = pinnedRoot.readFile(relativePath, { maxBytes: MAX_PERSISTED_STATE_BYTES });
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as unknown;
    const bounded = parseBoundedPersistedState(parsed);
    if (!bounded) return { ok: false, reason: "state exceeds bounded structural limits or has an unsafe object shape" };
    const issues: string[] = [];
    const state = normalizePersistedState(bounded, issues, {
      canonical_path: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
    });
    if (!state) return { ok: false, reason: `state is malformed${issues.length > 0 ? `: ${issues.join("; ")}` : ""}` };
    return { ok: true, state, raw: bounded };
  } catch (error) {
    return { ok: false, reason: `state is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
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

function taskTextWithinLimit(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= MAX_MARKER_TEXT_BYTES;
}

function markerPrefixAttempted(text: string): boolean {
  if (!taskTextWithinLimit(text)) return false;
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
  if (typeof text !== "string" || !taskTextWithinLimit(text)) return null;
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
export function validateSliceDoD(
  state: CtoState,
  teamId: string,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  if (!isSafeCtoId(teamId)) return "unsafe team id: refusing to resolve a slice DoD path";
  if (!state || typeof state !== "object" || !Array.isArray(state.teams)) {
    return "slice DoD unreadable: CtoState has no team records";
  }
  if (!pinnedRoot.isStable()) {
    return "slice DoD unreadable: pinned project root changed before the DoD read";
  }
  const root = pinnedRoot.canonical_root;
  const team = state.teams.find((t) => t && t.id === teamId);
  if (!team) return `unknown team ${teamId}: no team record in run ${displayCtoId(state.id)}`;
  const resolved = resolveDodPath(root, team.dod_path, teamId);
  if (!resolved.ok) return `slice DoD path invalid: ${resolved.reason}`;
  let dod: unknown;
  if (pinnedRoot) {
    const relativePath = pinnedRoot.relativePath(resolved.file);
    if (relativePath === null) return "slice DoD path invalid: resolved DoD is outside the pinned project root";
    const read = readDoDFilePinned(pinnedRoot, relativePath);
    if (!read.ok) return `slice DoD unreadable: ${resolved.file}: ${read.reason}`;
    dod = read.dod;
  }
  if (!dod || typeof dod !== "object" || Array.isArray(dod)) return `slice DoD unreadable: ${resolved.file} is not an object`;
  const items = (dod as { items?: unknown }).items;
  if (!Array.isArray(items)) return `slice DoD unreadable: ${resolved.file} has invalid items`;
  if (items.length === 0) return `slice DoD empty: ${resolved.file} has no items`;
  if (pinnedRoot && typeof team.dod_digest !== "string") return `slice DoD digest missing: team ${team.id} has no canonical DoD digest`;
  if (team.dod_digest !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(team.dod_digest)) return `slice DoD digest invalid: team ${team.id} does not carry a SHA-256 digest`;
    let actualDigest: string;
    try { actualDigest = canonicalCtoDoDDigest(dod); }
    catch (error) { return `slice DoD unreadable: ${resolved.file} has an invalid canonical projection: ${error instanceof Error ? error.message : String(error)}`; }
    if (actualDigest !== team.dod_digest) return `slice DoD digest mismatch: expected ${team.dod_digest}, got ${actualDigest}`;
  }
  if (pinnedRoot && !pinnedRoot.isStable()) return "slice DoD unreadable: pinned project root changed after the DoD read";
  return null;
}
function preClaimExecutionAdmissionError(
  state: CtoState,
  wave: NonNullable<ReturnType<typeof activeWave>>,
  team: CtoState["teams"][number],
  pinnedRoot: PinnedProjectRoot,
): string | null {
  if (team.status !== "pending" && team.status !== "in_progress") {
    return `slice ${String(team.slice_id)} is not pending dispatch (team status '${team.status}')`;
  }
  if (!isSafeFeatureId(team.feature_id) || typeof team.run_key !== "string" || team.run_key.trim().length === 0) {
    return `slice ${String(team.slice_id)} has no exact feature_id/run_key binding`;
  }
  const identity = team.work_identity;
  const waveIdentity = wave.work_identity;
  if (!identity || !waveIdentity
    || identity.run_id !== state.id
    || identity.wave_id !== wave.id
    || identity.slice_id !== team.slice_id
    || identity.stage_id !== "execution"
    || identity.stage_cursor !== "execution"
    || identity.capability_id !== waveIdentity.capability_id
    || identity.capability_epoch !== waveIdentity.capability_epoch
    || identity.slot_id !== team.slice_id
    || typeof identity.task_id !== "string"
    || identity.task_id.trim().length === 0
    || typeof identity.dispatch_id !== "string"
    || identity.dispatch_id.trim().length === 0
    || typeof identity.worker_id !== "string"
    || identity.worker_id.trim().length === 0) {
    return `slice ${String(team.slice_id)} has no exact active work_identity/dispatch identity`;
  }
  if (!Number.isSafeInteger(state.state_revision) || (state.state_revision ?? -1) < 0) {
    return `CTO run ${state.id} has an invalid state_revision`;
  }
  const plan = Array.isArray(state.plan?.teams)
    ? state.plan.teams.find((candidate) => candidate.slice === team.slice_id)
    : undefined;
  if (!plan || plan.team !== team.id || plan.team_def_id !== team.team_def_id || !Array.isArray(plan.scope) || plan.scope.length === 0 || plan.scope.some((scope) => typeof scope !== "string" || scope.trim().length === 0)) {
    return `slice ${String(team.slice_id)} has no exact canonical team scope`;
  }
  const featureState = readAdmissionFeatureState(pinnedRoot, team.feature_id!);
  if (!featureState.ok) return `feature '${team.feature_id}' ${featureState.reason}`;
  if (featureState.state.run_key !== team.run_key) return `feature '${team.feature_id}' run_key does not match CTO slice`;
  const revision = featureState.raw.state_revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) return `feature '${team.feature_id}' state revision is invalid`;
  return null;
}

/**
 * CTO execution waves are allowed to launch a task only after the generic
 * feature-state resolver and the CTO admission image agree. The active-feature
 * pointer may temporarily reference a legacy schema-1 feature image during
 * claim CAS; that image is not an authorization bypass.
 */
function strictExecutionAdmissionError(
  state: CtoState,
  wave: NonNullable<ReturnType<typeof activeWave>>,
  team: CtoState["teams"][number],
  root: string,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  const identity = team.work_identity!;

  const claimRead = readCurrentExecutionClaim(root, team.feature_id!, pinnedRoot);
  if (!claimRead.ok) return `${claimRead.code}: ${claimRead.error}`;
  const claim = claimRead.value;
  if (!claim || !isLiveExecutionClaim(claim) || claim.status !== "active" || claim.owner_kind !== "cto" || claim.owner_run_id !== state.id) {
    return `slice ${String(team.slice_id)} has no current active CTO claim for '${team.feature_id}'`;
  }
  const admission = claim.admission_binding;
  if (!admission
    || !isSafeRelativePath(admission.mapping_record_path)
    || !isSha256Hex(admission.mapping_record_digest)
    || !isSafeCtoExecutionId(admission.mapping_id)
    || !isSafeCtoExecutionId(admission.wave_id)
    || !isSha256Hex(admission.mapping_hash)
    || !Number.isSafeInteger(admission.mapping_version)
    || admission.mapping_version < 1
    || !Number.isSafeInteger(admission.confirmation_state_revision)
    || admission.confirmation_state_revision < 0
    || !Number.isSafeInteger(admission.feature_state_revision)
    || admission.feature_state_revision < 0
    || admission.wave_id !== wave.id
    || admission.capability_id !== identity.capability_id
    || admission.capability_epoch !== identity.capability_epoch
    || typeof admission.stage_id !== "string"
    || admission.stage_id.trim().length === 0
    || !isSha256Hex(admission.policy_hash)
    || !isSha256Hex(admission.confirmation_state_digest)
    || !isSha256Hex(admission.confirmation_authorization_digest)
    || !isSha256Hex(admission.confirmation_ledger_digest)
    || !isSafeRelativePath(admission.checkpoint_ref)
    || !isSafeRelativePath(admission.trusted_answer_ref)) {
    return `slice ${String(team.slice_id)} CTO claim admission binding is missing or stale`;
  }
  const expectedMappingPath = `.work-state/cto/${state.id}/specification-mappings/${admission.mapping_id}.json`;
  if (admission.mapping_record_path !== expectedMappingPath) return `slice ${String(team.slice_id)} CTO mapping path is not canonical`;
  const loadedMapping = readPinnedCtoMappingRecord(pinnedRoot, admission.mapping_record_path, state.id, admission.mapping_id);
  if (!loadedMapping.ok) return `slice ${String(team.slice_id)} CTO mapping record is unreadable: ${loadedMapping.error}`;
  if (loadedMapping.value.digest !== admission.mapping_record_digest) return `slice ${String(team.slice_id)} CTO mapping record digest changed`;
  const mappingRecord = loadedMapping.value.record;
  const mapping = mappingRecord.mapping;
  const mappingObject = mapping && typeof mapping === "object" && !Array.isArray(mapping) ? mapping as Record<string, unknown> : null;
  const execution = mappingObject?.execution;
  const executionObject = execution && typeof execution === "object" && !Array.isArray(execution) ? execution as Record<string, unknown> : null;
  if (
    mappingRecord.schema_version !== 1
    || mappingRecord.cto_run_id !== state.id
    || !mappingObject
    || mappingObject.status !== "confirmed"
    || mappingObject.mapping_id !== admission.mapping_id
    || mappingObject.mapping_hash !== admission.mapping_hash
    || mappingObject.mapping_version !== admission.mapping_version
    || !executionObject
    || executionObject.choice !== "cto"
    || executionObject.wave_id !== wave.id
    || executionObject.capability_id !== identity.capability_id
    || executionObject.capability_epoch !== identity.capability_epoch
    || mappingRecord.checkpoint_ref !== admission.checkpoint_ref
    || mappingRecord.trusted_answer_ref !== admission.trusted_answer_ref
  ) return `slice ${String(team.slice_id)} CTO mapping confirmation is stale or mismatched`;
  const confirmation = mappingRecord.confirmation_context;
  const confirmationObject = confirmation && typeof confirmation === "object" && !Array.isArray(confirmation) ? confirmation as Record<string, unknown> : null;
  if (!confirmationObject
    || confirmationObject.decision !== "approve_continue"
    || confirmationObject.capability_id !== admission.capability_id
    || confirmationObject.capability_epoch !== admission.capability_epoch
    || confirmationObject.stage_id !== admission.stage_id
    || confirmationObject.policy_hash !== admission.policy_hash) {
    return `slice ${String(team.slice_id)} CTO confirmation context is stale`;
  }
  const featureState = readAdmissionFeatureState(pinnedRoot, team.feature_id!);
  if (!featureState.ok) return `feature '${team.feature_id}' ${featureState.reason}`;
  if (featureState.state.run_key !== team.run_key) return `feature '${team.feature_id}' run_key does not match CTO slice`;
  const revision = featureState.raw.state_revision;
  if (!Number.isSafeInteger(revision) || (revision as number) !== admission.feature_state_revision) {
    return `feature '${team.feature_id}' state revision is stale or mismatched for CTO admission`;
  }
  const ownership = Array.isArray(mappingObject.task_to_slice) && mappingObject.task_to_slice.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const value = entry as Record<string, unknown>;
    return value.feature_id === team.feature_id && value.task_id === team.task_id && value.slice_id === team.slice_id && value.team_id === team.id;
  });
  if (!ownership) return `slice ${String(team.slice_id)} is not bound to the confirmed task scope`;
  const parallelization = Array.isArray(mappingObject.parallelization) && mappingObject.parallelization.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return (entry as Record<string, unknown>).slice_id === team.slice_id;
  });
  if (!parallelization) return `slice ${String(team.slice_id)} is not admitted by the confirmed mapping`;
  if (!pinnedRoot.isStable()) return "project root changed while validating CTO slice admission";
  return null;
}

/** Strong worker-only admission check; internal dispatch uses the pure slice gate before claiming. */
export function assertCtoWorkerTaskDispatchable(
  state: CtoState,
  opts: { sliceId: string; pinnedRoot: PinnedProjectRoot; markerRunId?: string },
): { ok: true } | { ok: false; reason: string } {
  const base = assertCtoSliceDispatchable(state, opts);
  if (!base.ok) return base;
  const wave = activeWave(state);
  const team = state.teams.find((candidate) => candidate.slice_id === opts.sliceId || candidate.id === opts.sliceId);
  if (!wave || !team || wave.source !== "specification-execution") return { ok: true };
  const ownedRoot = opts.pinnedRoot;
  const strictError = strictExecutionAdmissionError(state, wave, team, ownedRoot.canonical_root, ownedRoot);
  return strictError ? { ok: false, reason: strictError } : { ok: true };
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
  opts: { sliceId: string; pinnedRoot: PinnedProjectRoot; markerRunId?: string },
): { ok: true } | { ok: false; reason: string } {
  if (!state || typeof state !== "object" || !isSafeCtoId(state.id)) {
    return { ok: false, reason: "invalid canonical CtoState: unsafe or missing run id" };
  }
  if (!opts || typeof opts !== "object" || !isSafeCtoId(opts.sliceId)) {
    return { ok: false, reason: "unsafe slice id: refusing CTO slice dispatch" };
  }
  if (!opts.pinnedRoot || !opts.pinnedRoot.isStable()) {
    return { ok: false, reason: "invalid dispatch root: refusing CTO slice dispatch" };
  }
  const root = opts.pinnedRoot.canonical_root;
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
  if (wave.source === "specification-execution") {
    const ownedRoot = opts.pinnedRoot;
    try {
      const preclaimError = preClaimExecutionAdmissionError(state, wave, team, ownedRoot);
      if (preclaimError) return { ok: false, reason: preclaimError };
    } finally {
      // Borrowed pinned root remains owned by the caller.
    }
  }
  const clsErr = validateSliceClassification(team.classification);
  if (clsErr) return { ok: false, reason: `${clsErr} for slice ${opts.sliceId} (team ${team.id})` };
  // 5. persisted workflow must match the matrix (classification validated above)
  const wfErr = validateSliceWorkflow(team.classification as ModelClassification, team.workflow);
  if (wfErr) return { ok: false, reason: `${wfErr} for slice ${opts.sliceId} (team ${team.id})` };
  // 6. per-slice DoD must be structurally present before any worker spawn
  const dodErr = validateSliceDoD(state, team.id, opts.pinnedRoot);
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
export function extractTaskMarkers(
  input: unknown,
):
  | { kind: "single"; marker: SliceMarker | null; attempted: boolean }
  | { kind: "batch"; items: Array<{ marker: SliceMarker | null; attempted: boolean }> }
  | { kind: "invalid"; reason: "batch_size" | "task_text" }
  | { kind: "ambiguous" }
  | { kind: "none" } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { kind: "none" };
  const rec = input as Record<string, unknown>;
  const hasTaskField = Object.prototype.hasOwnProperty.call(rec, "task");
  const hasTasksField = Object.prototype.hasOwnProperty.call(rec, "tasks");
  if (hasTaskField && hasTasksField) return { kind: "ambiguous" };
  if (hasTaskField && typeof rec.task === "string") {
    const text = rec.task;
    if (!taskTextWithinLimit(text)) return { kind: "invalid", reason: "task_text" };
    const marker = parseCtoSliceMarker(text);
    return { kind: "single", marker, attempted: marker === null && markerPrefixAttempted(text) };
  }
  if (hasTasksField && Array.isArray(rec.tasks)) {
    if (rec.tasks.length > MAX_TASK_BATCH_ITEMS) return { kind: "invalid", reason: "batch_size" };
    const items: Array<{ marker: SliceMarker | null; attempted: boolean }> = [];
    for (let index = 0; index < rec.tasks.length; index += 1) {
      const text = ownTaskText(rec.tasks[index]);
      if (text !== null) {
        if (!taskTextWithinLimit(text)) return { kind: "invalid", reason: "task_text" };
        const marker = parseCtoSliceMarker(text);
        items.push({
          marker: marker ? { ...marker, item: index } : null,
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

function ctoDeliveryStatus(state: CtoState): "active" | "standby" | "done" | "failed" {
  if (state.pause?.kind === "done") return "done";
  if (state.pause?.kind === "failed") return "failed";
  return state.standby === true ? "standby" : "active";
}

/**
 * Find an active CTO wave from the reconciled canonical delivery set.
 *
 * The bounded reconciler repairs schema-valid omissions and stale index fields
 * before authorization; unreadable canonical candidates fail closed.
 */
function findActiveWave(pinnedRoot: PinnedProjectRoot): { runId: string; waveId: string } | null {
  if (!pinnedRoot.isStable()) throw new Error("project root changed before CTO active-wave recovery");
  const index = readCtoRunDeliveryReconciledActiveCandidatesPinned(pinnedRoot);
  if (!index.ok) throw new Error(`recovery_required: CTO active-wave delivery authority is unavailable (${index.code})`);
  if (!readCtoRunDeliveryIndexAuthorityPinned(pinnedRoot).authenticated) {
    if (index.entries.some((entry) => entry.status === "active" || entry.status === "standby")) {
      throw new Error("CTO active-wave authority recovery_required: canonical resident state exists but process-scoped owner proof is unavailable");
    }
    return null;
  }

  let best: { runId: string; waveId: string; updatedAt: string } | null = null;
  for (const entry of index.entries) {
    const state = readCtoStatePinned(entry.run_id, pinnedRoot);
    if (!state || state.id !== entry.run_id) {
      throw new Error(`CTO active-wave authority unavailable: canonical state for indexed run '${entry.run_id}' is unreadable or has mismatched identity`);
    }
    const rawRevision = state.state_revision;
    const revision = typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : 0;
    if (entry.state_revision !== revision
      || entry.status !== ctoDeliveryStatus(state)
      || entry.updated_at !== state.updated_at
      || entry.summary_digest !== ctoRunDeliverySummaryDigest(state)) {
      throw new Error(`CTO active-wave authority invalid: delivery entry for indexed run '${entry.run_id}' does not match canonical state`);
    }
    const wave = activeWave(state);
    // A canonical active run can legitimately have no active wave between waves.
    if (!wave) continue;
    const waveId = isSafeCtoExecutionId(wave.id) ? wave.id : "<invalid>";
    if (waveId === "<invalid>") {
      throw new Error(`CTO active-wave authority invalid: indexed run '${entry.run_id}' has an unsafe active wave id`);
    }
    const updatedAt = typeof state.updated_at === "string" ? state.updated_at.slice(0, 64) : entry.updated_at;
    if (!best || updatedAt > best.updatedAt || (updatedAt === best.updatedAt && entry.run_id > best.runId)) {
      best = { runId: entry.run_id, waveId, updatedAt };
    }
  }
  return best ? { runId: best.runId, waveId: best.waveId } : null;
}
function preparationSliceOwnershipError(state: CtoState, sliceId: string, taskText: string | null): string | null {
  const wave = activeWave(state);
  if (!wave || wave.source !== "specification-preparation" || taskText === null) return null;
  const dispatch = parseDispatchMarker(taskText);
  if (!dispatch) return null;
  const team = state.teams.find((candidate) => candidate.slice_id === sliceId || candidate.id === sliceId);
  if (!team || typeof team.run_key !== "string") return null;
  return dispatch.run === team.run_key ? null : "slice " + sliceId + " task dispatch run mismatch: expected feature run " + team.run_key + ", marker says " + dispatch.run;
}
function taskTextAt(input: unknown, index?: number): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (index === undefined) return typeof value.task === "string" ? value.task : null;
  return Array.isArray(value.tasks) ? ownTaskText(value.tasks[index]) : null;
}
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
 */
export function isActiveCtoExecutionTask(
  event: { toolName?: string; input?: unknown },
  ctx: { cwd: string },
): boolean {
  if (event?.toolName !== "task") return false;
  const parsed = extractTaskMarkers(event.input);
  if (parsed.kind === "invalid") return false;
  const pinnedRoot = PinnedProjectRoot.open(ctx.cwd);
  if (!pinnedRoot) return false;
  try {
    if (parsed.kind === "single") {
      if (!parsed.marker) return false;
      const state = readCtoStatePinned(parsed.marker.runId, pinnedRoot);
      const wave = state ? activeWave(state) : null;
      return Boolean(state && state.id === parsed.marker.runId && wave && wave.source === "specification-execution" && wave.status === "active");
    }
    if (parsed.kind !== "batch" || parsed.items.length === 0) return false;
    for (const item of parsed.items) {
      if (!item.marker) return false;
      const state = readCtoStatePinned(item.marker.runId, pinnedRoot);
      const wave = state ? activeWave(state) : null;
      if (!state || state.id !== item.marker.runId || !wave || wave.source !== "specification-execution" || wave.status !== "active") return false;
    }
    return true;
  } finally {
    pinnedRoot.close();
  }
}
export function ctoSliceTaskGate(
  event: { toolName?: string; input?: unknown },
  ctx: { cwd: string },
): { block: true; reason: string } | undefined {
  try {
    if (event?.toolName !== "task") return undefined;
    const pinnedRoot = PinnedProjectRoot.open(ctx.cwd);
    if (!pinnedRoot) {
      return { block: true, reason: "cto slice gate: project root could not be pinned safely — refusing task launch" };
    }
    try {
      const parsed = extractTaskMarkers(event.input);
      if (parsed.kind === "invalid") {
        const active = findActiveWave(pinnedRoot);
        if (!active) return undefined;
        const reason = parsed.reason === "batch_size"
          ? `task batch exceeds ${MAX_TASK_BATCH_ITEMS} items; refusing unbounded task payload`
          : `task payload exceeds ${MAX_MARKER_TEXT_BYTES} UTF-8 bytes; refusing oversized task payload`;
        return { block: true, reason: `cto slice gate: active wave ${active.waveId} in run ${active.runId} — ${reason}` };
      }

      if (parsed.kind === "single") {
        if (!parsed.marker) {
          const active = findActiveWave(pinnedRoot);
          return active ? { block: true, reason: noMarkerBlockReason(active, parsed.attempted, undefined) } : undefined;
        }
        const state = readCtoStatePinned(parsed.marker.runId, pinnedRoot);
        if (!state) {
          return {
            block: true,
            reason: `no CtoState for run ${parsed.marker.runId} at .work-state/cto/${parsed.marker.runId}/state.json — cannot dispatch CTO slice ${parsed.marker.sliceId}`,
          };
        }
        const res = assertCtoWorkerTaskDispatchable(state, { sliceId: parsed.marker.sliceId, pinnedRoot, markerRunId: parsed.marker.runId });
        if (!res.ok) return { block: true, reason: "cto slice gate: " + res.reason };
        const ownershipError = preparationSliceOwnershipError(state, parsed.marker.sliceId, taskTextAt(event.input));
        if (ownershipError) return { block: true, reason: "cto slice gate: " + ownershipError };
        return undefined;
      }

      if (parsed.kind === "batch") {
        if (parsed.items.length === 0) {
          const active = findActiveWave(pinnedRoot);
          return active ? { block: true, reason: noMarkerBlockReason(active, false, undefined) } : undefined;
        }
        const missingIndex = parsed.items.findIndex((item) => item.marker === null);
        const activeForMissing = missingIndex >= 0 ? findActiveWave(pinnedRoot) : null;
        if (missingIndex >= 0 && !activeForMissing) return undefined;
        for (let index = 0; index < parsed.items.length; index += 1) {
          const item = parsed.items[index]!;
          if (!item.marker) {
            if (activeForMissing) return { block: true, reason: noMarkerBlockReason(activeForMissing, item.attempted, index) };
            continue;
          }
          const marker = item.marker;
          const state = readCtoStatePinned(marker.runId, pinnedRoot);
          if (!state) {
            return {
              block: true,
              reason: `no CtoState for run ${marker.runId} at .work-state/cto/${marker.runId}/state.json — cannot dispatch CTO slice ${marker.sliceId} (batch task item ${marker.item})`,
            };
          }
          const res = assertCtoWorkerTaskDispatchable(state, { sliceId: marker.sliceId, pinnedRoot, markerRunId: marker.runId });
          if (!res.ok) return { block: true, reason: "cto slice gate: " + res.reason + " (batch task item " + marker.item + ")" };
          const ownershipError = preparationSliceOwnershipError(state, marker.sliceId, taskTextAt(event.input, index));
          if (ownershipError) return { block: true, reason: "cto slice gate: " + ownershipError + " (batch task item " + marker.item + ")" };
        }
        return undefined;
      }

      if (parsed.kind === "ambiguous") {
        const active = findActiveWave(pinnedRoot);
        if (!active) return undefined;
        return {
          block: true,
          reason: `cto slice gate: active wave ${active.waveId} in run ${active.runId} — ambiguous task payload has both task and tasks fields; provide exactly one marker-bearing shape or fold the work into the wave`,
        };
      }

      const active = findActiveWave(pinnedRoot);
      return active ? { block: true, reason: noMarkerBlockReason(active, false, undefined) } : undefined;
    } finally {
      pinnedRoot.close();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { block: true, reason: `cto slice gate: recovery_required: ${reason}` };
  }
}
