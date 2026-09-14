/**
 * Wave scheduling + digest (architecture §4.9, br-zps.8).
 *
 * Session timers are best-effort wakeups; durable CTO state remains canonical.
 */

import type { CtoState, ScheduledDigest } from "./types.js";
import { MAX_PREPARATION_QUEUE_ITEMS } from "./types.js";
import { isSafeCtoRunId } from "./state.js";
import { recallDecisions } from "./decisions.js";
import { assessRunHealth } from "./health.js";
import { checkBudget } from "./budget.js";
import type { WorkspacePhase } from "../specification/types.js";
import { isSafeFeatureId, isSha256Hex, sha256Hex } from "../specification/validation.js";
import { isNonResidentCtoRun, nonResidentCtoRunReason } from "../gates/cto-nesting.js";

export function shouldRunWave(state: CtoState, now?: number): boolean {
  const intervalMs = state.scheduler?.wave_interval_ms;
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) return false;
  const lastWaveAt = state.scheduler?.last_wave_at;
  if (lastWaveAt === undefined) return true;
  const lastMs = Date.parse(lastWaveAt);
  if (Number.isNaN(lastMs)) return true;
  return (now ?? Date.now()) - lastMs >= intervalMs;
}

export interface CtoSchedulerStateAdapter {
  /** Read the current authenticated CTO state snapshot. */
  read(): CtoState;
  /** Apply a synchronous pure state transition inside an authenticated transaction. */
  update(mutator: (state: CtoState) => CtoState): CtoState;
}

export function buildDigest(state: CtoState): ScheduledDigest {
  const health = assessRunHealth(state);
  return {
    run_id: state.id,
    at: new Date().toISOString(),
    health,
    recent_decisions: recallDecisions(state, { limit: 10 }),
    open_escalations: health.pending_escalations,
    budget_status: checkBudget(state).status,
  };
}

export function startWaveScheduler(
  state: CtoState,
  adapter: CtoSchedulerStateAdapter,
  intervalMs: number,
  onWave: () => void,
): () => void {
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.update !== "function") {
    throw new Error("CTO scheduler requires an authenticated state adapter");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || typeof onWave !== "function") return () => {};

  // Scheduler metadata is a non-authority wakeup hint. Every mutation is
  // delegated to the authenticated adapter; this module never opens or
  // writes a project-root state file itself.
  adapter.update((current) => {
    const next = structuredClone(current);
    next.scheduler = next.scheduler ?? { wave_interval_ms: 0 };
    next.scheduler.wave_interval_ms = intervalMs;
    return next;
  });

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
  };
  timer = setInterval(() => {
    if (stopped) return;
    try {
      const fresh = adapter.read();
      if (!shouldRunWave(fresh, Date.now())) return;
      // Keep the transaction closed while the callback runs. Runtime wave
      // handling may itself acquire the authenticated run transaction.
      onWave();
      if (stopped) return;
      adapter.update((current) => {
        const next = structuredClone(current);
        next.scheduler = next.scheduler ?? { wave_interval_ms: 0 };
        next.scheduler.wave_interval_ms = intervalMs;
        next.scheduler.last_wave_at = new Date().toISOString();
        next.scheduler.next_wave_at = new Date(Date.now() + intervalMs).toISOString();
        return next;
      });
    } catch (error) {
      console.error("[cto-scheduler] wave tick failed:", error);
      stop();
    }
  }, intervalMs);
  timer.unref?.();
  return stop;
}

// ── CTO specification preparation scheduling (T103/T106) ────────────────────

const PREPARATION_PHASES: readonly WorkspacePhase[] = ["specify", "plan", "tasks"];

export interface CtoSpecificationPreparationRequest {
  request_id: string;
  feature_id: string;
  run_key: string;
  phase: WorkspacePhase;
  facet_id: string;
  profile_name: string;
  profile_hash: string;
  owner_id?: string;
  active_phase?: WorkspacePhase;
}

export interface CtoSpecificationPreparationScheduleInput {
  cto_run_id: string;
  resident_cto_run_id: string;
  depth: number;
  max_depth: number;
  capacity: number;
  requests: CtoSpecificationPreparationRequest[];
}

export type CtoSpecificationPreparationQueueReasonCode =
  | "capacity"
  | "depth"
  | "ownership"
  | "active_phase"
  | "same_feature_serialized"
  | "nested_cto";

export interface CtoSpecificationPreparationScheduledRequest extends CtoSpecificationPreparationRequest {
  phase_writer_id: string;
}

export interface CtoSpecificationPreparationQueuedRequest extends CtoSpecificationPreparationRequest {
  reason_code: CtoSpecificationPreparationQueueReasonCode;
  reason: string;
}

export interface CtoSpecificationPreparationScheduleResult {
  scheduled: CtoSpecificationPreparationScheduledRequest[];
  queued: CtoSpecificationPreparationQueuedRequest[];
  phase_writers: Record<string, string>;
}
function requireSafeSegment(value: unknown, field: string): string {
  if (typeof value !== "string" || !isSafeCtoRunId(value)) {
    throw new Error(
      `scheduleCtoSpecificationPreparation: ${field} must be a canonical non-reserved state id (got ${JSON.stringify(value) ?? String(value)})`,
    );
  }
  return value;
}

function requirePreparationProfile(value: unknown, field: string): string {
  if (value !== "spec-preparation") {
    throw new Error(
      `scheduleCtoSpecificationPreparation: ${field} must be "spec-preparation" (got ${JSON.stringify(value) ?? String(value)})`,
    );
  }
  return value;
}
function requirePreparationPhase(value: unknown, field: string): WorkspacePhase {
  if (typeof value !== "string" || !PREPARATION_PHASES.includes(value as WorkspacePhase)) {
    throw new Error(
      `scheduleCtoSpecificationPreparation: ${field} must be one of specify|plan|tasks (got ${JSON.stringify(value) ?? String(value)})`,
    );
  }
  return value as WorkspacePhase;
}

function validatePreparationRequest(request: CtoSpecificationPreparationRequest, index: number): void {
  const at = `requests[${index}]`;
  if (!request || typeof request !== "object") {
    throw new Error(`scheduleCtoSpecificationPreparation: ${at} must be an object`);
  }
  requireSafeSegment(request.request_id, `${at}.request_id`);
  if (!isSafeFeatureId(request.feature_id)) {
    throw new Error(`scheduleCtoSpecificationPreparation: ${at}.feature_id must be a canonical safe feature id`);
  }
  requireSafeSegment(request.run_key, `${at}.run_key`);
  requirePreparationPhase(request.phase, `${at}.phase`);
  requireSafeSegment(request.facet_id, `${at}.facet_id`);
  requirePreparationProfile(request.profile_name, `${at}.profile_name`);
  if (!isSha256Hex(request.profile_hash)) {
    throw new Error(
      `scheduleCtoSpecificationPreparation: ${at}.profile_hash must be a sha-256 hex digest (got ${JSON.stringify(request.profile_hash) ?? String(request.profile_hash)})`,
    );
  }
  if (request.owner_id !== undefined) requireSafeSegment(request.owner_id, `${at}.owner_id`);
  if (request.active_phase !== undefined) requirePreparationPhase(request.active_phase, `${at}.active_phase`);
}

function phaseWriterId(featureId: string, phase: WorkspacePhase): string {
  return `cto-writer-${sha256Hex(`${featureId}\u0000${phase}`).slice(0, 16)}`;
}

/**
 * Schedule independent safe feature requests up to capacity. Every selector
 * is validated before any slot/path identity is derived.
 */
export function scheduleCtoSpecificationPreparation(
  input: CtoSpecificationPreparationScheduleInput,
): CtoSpecificationPreparationScheduleResult {
  if (!input || typeof input !== "object") {
    throw new Error("scheduleCtoSpecificationPreparation: input must be an object");
  }
  const ctoRunId = requireSafeSegment(input.cto_run_id, "cto_run_id");
  const residentRunId = requireSafeSegment(input.resident_cto_run_id, "resident_cto_run_id");
  if (!Number.isSafeInteger(input.depth) || input.depth < 0) {
    throw new Error("scheduleCtoSpecificationPreparation: depth must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.max_depth) || input.max_depth < 0) {
    throw new Error("scheduleCtoSpecificationPreparation: max_depth must be a non-negative safe integer");
  }
  if (input.depth > input.max_depth) {
    throw new Error("scheduleCtoSpecificationPreparation: depth must not exceed max_depth");
  }
  if (!Array.isArray(input.requests)) {
    throw new Error("scheduleCtoSpecificationPreparation: requests must be an array");
  }
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 0) {
    throw new Error("scheduleCtoSpecificationPreparation: capacity must be a non-negative integer");
  }
  if (input.requests.length > 0 && input.capacity === 0) {
    throw new Error("scheduleCtoSpecificationPreparation: capacity must be at least 1 when requests are present");
  }
  if (input.requests.length > MAX_PREPARATION_QUEUE_ITEMS) {
    throw new Error(`scheduleCtoSpecificationPreparation: requests may contain at most ${MAX_PREPARATION_QUEUE_ITEMS} entries`);
  }
  input.requests.forEach(validatePreparationRequest);

  const scheduled: CtoSpecificationPreparationScheduledRequest[] = [];
  const queued: CtoSpecificationPreparationQueuedRequest[] = [];
  const phase_writers: Record<string, string> = {};
  const claimedWriters = new Set<string>();
  const claimedOwners = new Set<string>();

  const nested = isNonResidentCtoRun(ctoRunId, residentRunId);
  const nestedReason = nested ? nonResidentCtoRunReason(ctoRunId, residentRunId) : null;

  for (const request of input.requests) {
    if (nestedReason) {
      queued.push({ ...request, reason_code: "nested_cto", reason: nestedReason });
      continue;
    }
    if (input.depth >= input.max_depth) {
      queued.push({
        ...request,
        reason_code: "depth",
        reason: `decomposition depth ${input.depth} has reached max_depth ${input.max_depth}; deeper preparation must be coordinated by the resident CTO at a shallower depth`,
      });
      continue;
    }
    if (request.active_phase !== undefined && request.active_phase !== request.phase) {
      queued.push({
        ...request,
        reason_code: "active_phase",
        reason: `feature '${request.feature_id}' is mid-phase '${request.active_phase}'; requested phase '${request.phase}' is out of order until the active phase closes`,
      });
      continue;
    }
    const slot = `${request.feature_id}:${request.phase}`;
    if (claimedWriters.has(slot)) {
      queued.push({
        ...request,
        reason_code: "same_feature_serialized",
        reason: `feature '${request.feature_id}' phase '${request.phase}' already has the phase writer '${phase_writers[slot]}' in this batch; facet '${request.facet_id}' is queued behind it`,
      });
      continue;
    }
    if (request.owner_id !== undefined && claimedOwners.has(request.owner_id)) {
      queued.push({
        ...request,
        reason_code: "ownership",
        reason: `owner '${request.owner_id}' already holds a scheduled preparation row in this batch; duplicate owner claims are queued`,
      });
      continue;
    }
    if (scheduled.length >= input.capacity) {
      queued.push({
        ...request,
        reason_code: "capacity",
        reason: `capacity ${input.capacity} reached with ${scheduled.length} preparation rows already scheduled; further work queues until a slot frees`,
      });
      continue;
    }
    const writer = phaseWriterId(request.feature_id, request.phase);
    claimedWriters.add(slot);
    if (request.owner_id !== undefined) claimedOwners.add(request.owner_id);
    phase_writers[slot] = writer;
    scheduled.push({ ...request, phase_writer_id: writer });
  }
  return { scheduled, queued, phase_writers };
}
