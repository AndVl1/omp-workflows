import {
  applyAppendWaveTransition,
  applyFinishWaveTransition,
  type AppendWaveOptions,
  type FinishWaveOptions,
} from "./state.js";
import type { CtoState } from "./types.js";
import {
  assertCtoRunLockHandle,
  type CtoRunLockHandle,
} from "./transaction-lock.js";
import { validateTypedControlPlane } from "../engine/workflow-contract.js";
import { isSha256Hex } from "../specification/validation.js";
import type { WorkIdentity } from "../engine/types.js";

const WORK_IDENTITY_KEYS = [
  "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id",
  "stage_cursor", "capability_id", "capability_epoch", "slot_id", "task_id",
  "dispatch_id", "attempt", "worker_id",
] as const;

type StateTeam = CtoState["teams"][number];

function replaceState(target: CtoState, next: CtoState): void {
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete (target as unknown as Record<string, unknown>)[key];
  }
  Object.assign(target, next);
}

function sameWorkIdentity(left: WorkIdentity, right: WorkIdentity): boolean {
  return WORK_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function assertCanonicalWorkIdentity(value: unknown, label: string): asserts value is WorkIdentity {
  const result = validateTypedControlPlane({ work_identity: value });
  if (!result.ok) {
    throw new Error(`${label} is not a canonical engine work identity`);
  }
}

function specificationTeams(state: CtoState, opts: AppendWaveOptions, requirePending = true): StateTeam[] {
  const teams = Array.isArray(state.teams) ? state.teams : [];
  if (teams.length === 0) throw new Error("specification-execution wave requires admitted execution slices");
  if (!Array.isArray(opts.slice_ids) || opts.slice_ids.length === 0) {
    throw new Error("specification-execution wave requires explicit admitted slices");
  }
  const requestedSlices = new Set(opts.slice_ids);
  const actualTeamSlices = teams.map((team) => team.slice_id);
  const actualSlices = new Set(actualTeamSlices);
  if (requestedSlices.size !== opts.slice_ids.length
    || actualSlices.size !== actualTeamSlices.length
    || actualSlices.size !== requestedSlices.size
    || actualTeamSlices.some((sliceId) => typeof sliceId !== "string" || !requestedSlices.has(sliceId))) {
    throw new Error("specification-execution wave slices do not exactly cover the admitted teams");
  }
  const selected = state.specification_execution_requested_selections;
  if (!Array.isArray(selected) || selected.length === 0) {
    throw new Error("specification-execution wave requires the canonical execution selections");
  }
  const selectedKeys = new Set<string>();
  for (const selection of selected) {
    if (!selection || typeof selection.feature_id !== "string" || typeof selection.run_key !== "string") continue;
    selectedKeys.add(`${selection.feature_id}\0${selection.run_key}`);
  }
  const matched: StateTeam[] = [];
  for (const team of teams) {
    if (requirePending && team.status !== "pending") throw new Error("specification-execution slice is not in the admitted pending state");
    if (typeof team.slice_id !== "string" || !requestedSlices.has(team.slice_id)
      || typeof team.feature_id !== "string" || typeof team.run_key !== "string"
      || !selectedKeys.has(`${team.feature_id}\0${team.run_key}`)) {
      throw new Error("specification-execution wave team is not covered by the canonical execution selections");
    }
    if (!team.work_identity) throw new Error(`specification-execution slice '${team.slice_id}' has no engine work identity`);
    assertCanonicalWorkIdentity(team.work_identity, `specification-execution slice '${team.slice_id}' work identity`);
    matched.push(team);
  }
  return matched;
}

/**
 * A specification-execution wave is admitted only from the committed,
 * engine-prepared execution image. The direct module is intentionally
 * conservative: mapping/handoff and conformance authority live at the
 * command layer, while this check binds every persisted slice to the exact
 * identities already written into CtoState.
 */
function assertSpecificationExecutionAdmission(state: CtoState, opts: AppendWaveOptions): void {
  if (opts.source !== "specification-execution") return;
  if (!opts.work_identity) throw new Error("specification-execution wave requires an engine-issued work identity");
  assertCanonicalWorkIdentity(opts.work_identity, "specification-execution wave work identity");
  if (opts.work_identity.run_id !== state.id
    || opts.work_identity.wave_id !== opts.id
    || opts.work_identity.stage_id !== "execution"
    || opts.work_identity.stage_cursor !== "execution") {
    throw new Error("specification-execution wave identity is not bound to the exact run and wave");
  }
  const transaction = state.specification_preparation_transaction;
  if (!transaction
    || transaction.status !== "committed"
    || transaction.kind === "bootstrap"
    || !isSha256Hex(transaction.request_digest)
    || !Number.isSafeInteger(transaction.expected_state_revision)
    || transaction.expected_state_revision < 0) {
    throw new Error("specification-execution wave requires a committed preparation transaction");
  }
  const anchor = state.specification_execution_anchor;
  if (!anchor || typeof anchor.feature_id !== "string" || typeof anchor.run_key !== "string") {
    throw new Error("specification-execution wave requires the canonical execution anchor");
  }
  const teams = specificationTeams(state, opts);
  const firstTeam = teams.find((team) => team.work_identity?.slice_id === opts.work_identity?.slice_id);
  if (!firstTeam?.work_identity || !sameWorkIdentity(firstTeam.work_identity, opts.work_identity)) {
    throw new Error("specification-execution wave identity is not the exact admitted slice identity");
  }
  const capabilityId = opts.work_identity.capability_id;
  const capabilityEpoch = opts.work_identity.capability_epoch;
  for (const team of teams) {
    const identity = team.work_identity!;
    if (identity.run_id !== state.id
      || identity.wave_id !== opts.id
      || identity.stage_id !== "execution"
      || identity.stage_cursor !== "execution"
      || identity.capability_id !== capabilityId
      || identity.capability_epoch !== capabilityEpoch
      || identity.slice_id !== team.slice_id) {
      throw new Error("specification-execution wave contains a stale or foreign slice identity");
    }
  }
  if (!teams.some((team) => team.feature_id === anchor.feature_id && team.run_key === anchor.run_key)) {
    throw new Error("specification-execution wave anchor is not covered by an admitted execution slice");
  }
}

function applyAppendWave(state: CtoState, opts: AppendWaveOptions, handle?: CtoRunLockHandle): CtoState {
  if (handle) assertCtoRunLockHandle(handle, handle.canonical_root, state.id);
  assertSpecificationExecutionAdmission(state, opts);
  return applyAppendWaveTransition(state, opts);
}

function applyFinishWave(state: CtoState, opts: FinishWaveOptions, handle?: CtoRunLockHandle): CtoState {
  if (handle) assertCtoRunLockHandle(handle, handle.canonical_root, state.id);
  const wave = state.wave_history?.find((candidate) => candidate.id === opts.id);
  if (wave?.source === "specification-execution") {
    throw new Error("generic wave finish rejects specification-execution; use the authoritative CTO close command");
  }
  return applyFinishWaveTransition(state, opts);
}

/**
 * Apply an admitted wave transition without persistence. Durable callers must
 * invoke this pure transition through an authenticated runtime transaction.
 */
export function appendWave(state: CtoState, opts: AppendWaveOptions): CtoState {
  return applyAppendWave(state, opts);
}

/** Apply a terminal wave transition without persistence. */
export function finishWave(state: CtoState, opts: FinishWaveOptions): CtoState {
  return applyFinishWave(state, opts);
}

/**
 * Apply a wave transition inside an already-held run lock. The runtime handle
 * is issued only by withCtoRunLock and cannot be forged from its public shape.
 */
export function appendWaveUnderLock(
  state: CtoState,
  opts: AppendWaveOptions,
  handle: CtoRunLockHandle,
): CtoState {
  const next = applyAppendWave(state, opts, handle);
  if (next !== state) replaceState(state, next);
  return state;
}

/** Apply a terminal wave transition inside an already-held run lock. */
export function finishWaveUnderLock(
  state: CtoState,
  opts: FinishWaveOptions,
  handle: CtoRunLockHandle,
): CtoState {
  const next = applyFinishWave(state, opts, handle);
  if (next !== state) replaceState(state, next);
  return state;
}
