/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import {
  createDiagnostic,
  isCanonicalRoot,
  isTrustedFsAuthority,
  shouldRunWave,
  validateWorkflowRunIdentity,
  type CanonicalRoot,
  type CtoState,
  type DiagnosticResult,
  type TrustedFsAuthority,
  type WorkflowRunIdentity,
  type WorkflowV2Diagnostic,
} from "@andvl1/omp-workflows-core";
import { validateFullstackInventoryAdmission, type FullstackInventoryAdmissionContext } from "./agent-mapping.js";
import { isFullstackStorageAuthority, type FullstackStorageAuthority } from "./storage-authority.js";

export interface SchedulerAdmission {
  readonly inventory_admission: FullstackInventoryAdmissionContext;
  /** Exact opaque authorities that were admitted for this scheduler root/run. */
  readonly filesystem_authority: TrustedFsAuthority;
  readonly storage: FullstackStorageAuthority;
}

export interface CtoSchedulerDaemonOpts {
  readonly project_root: CanonicalRoot;
  readonly run_identity: WorkflowRunIdentity;
  readonly state: CtoState;
  readonly filesystem_authority: TrustedFsAuthority;
  /** Pinned storage is used for the initial and every tick state read/write. */
  readonly storage?: FullstackStorageAuthority;
  readonly admission: SchedulerAdmission;
  /** Positive polling interval and initializer when canonical scheduler state is missing. */
  readonly intervalMs: number;
  readonly onWave: () => void;
  /** Receives typed diagnostics emitted after daemon activation. */
  readonly onDiagnostic?: (diagnostic: WorkflowV2Diagnostic) => void;
}

export interface CtoSchedulerDaemonHandle {
  readonly stop: () => void;
}

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_TIMER_INTERVAL_MS = 86_400_000;
const MAX_DATE_TIME_MS = 8_640_000_000_000_000;

function isDateSafeTimestamp(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_DATE_TIME_MS;
}

function isPositiveDateSafeInterval(value: unknown, now: number): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return false;
  return isDateSafeTimestamp(now) && isDateSafeTimestamp(now + value);
}

function isInvalidPersistedInterval(value: unknown, now: number): boolean {
  return typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    && !isPositiveDateSafeInterval(value, now);
}

function schedulerIntervalDiagnostic(field: string): WorkflowV2Diagnostic {
  return createDiagnostic({
    code: "ACTIVATION_FAILED",
    operation: "runtime.activate",
    evidence: { field },
    remediation: "Provide a positive safe-integer scheduler interval whose next wave timestamp remains within the ECMAScript Date range.",
  });
}

function failure<T>(code: "IDENTITY_MISMATCH" | "CAPABILITY_MISSING" | "ACTIVATION_FAILED" | "MIGRATION_REQUIRED", field: string, remediation: string): DiagnosticResult<T> {
  return {
    ok: false,
    diagnostics: [createDiagnostic({ code, operation: "runtime.activate", evidence: { field }, remediation })],
  };
}

function reportDiagnostic(
  onDiagnostic: ((diagnostic: WorkflowV2Diagnostic) => void) | undefined,
  diagnostic: WorkflowV2Diagnostic,
): void {
  try { onDiagnostic?.(diagnostic); } catch { /* diagnostics must not break the scheduler */ }
}

function schedulerPersistenceFailureDiagnostic(): WorkflowV2Diagnostic {
  return createDiagnostic({
    code: "ACTIVATION_FAILED",
    operation: "runtime.activate",
    evidence: { field: "scheduler.state" },
    remediation: "The scheduler stopped because its post-wave state could not be persisted; restore writable identity-bound storage before restarting.",
  });
}

function sameProject(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id;
}

function sameRun(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return sameProject(left, right)
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function validateSchedulerAdmission(
  admission: SchedulerAdmission | undefined,
  projectRoot: CanonicalRoot,
  run: WorkflowRunIdentity,
  filesystemAuthority: TrustedFsAuthority,
  storage: FullstackStorageAuthority,
): DiagnosticResult<FullstackInventoryAdmissionContext> {
  if (!admission || typeof admission !== "object") {
    return failure("CAPABILITY_MISSING", "admission", "Provide the host-issued fullstack inventory admission for the active project runtime.");
  }
  if (!isTrustedFsAuthority(admission.filesystem_authority)) {
    return failure("CAPABILITY_MISSING", "admission.filesystem_authority", "Provide the launcher-issued trusted filesystem authority already admitted for this scheduler root.");
  }
  if (admission.filesystem_authority !== filesystemAuthority) {
    return failure("IDENTITY_MISMATCH", "admission.filesystem_authority", "Use the exact filesystem authority already admitted for this scheduler root.");
  }
  if (!isFullstackStorageAuthority(admission.storage)) {
    return failure("CAPABILITY_MISSING", "admission.storage", "Provide the pinned FullstackStorageAuthority already admitted for this scheduler root.");
  }
  if (admission.storage !== storage) {
    return failure("IDENTITY_MISMATCH", "admission.storage", "Use the exact storage authority already admitted for this scheduler root.");
  }
  const inventoryAdmission = admission.inventory_admission;
  if (!inventoryAdmission || typeof inventoryAdmission !== "object") {
    return failure("CAPABILITY_MISSING", "admission.inventory_admission", "Provide the host-issued fullstack inventory admission for the active project runtime.");
  }
  if (
    !isCanonicalRoot(inventoryAdmission.canonical_root)
    || inventoryAdmission.canonical_root !== projectRoot
  ) {
    return failure("IDENTITY_MISMATCH", "admission.inventory_admission.canonical_root", "Use inventory admission bound to the exact scheduler project root.");
  }
  const authorityContext = inventoryAdmission.authority_context;
  if (
    !authorityContext
    || typeof authorityContext !== "object"
    || !isCanonicalRoot(authorityContext.canonical_root)
    || authorityContext.canonical_root !== projectRoot
    || authorityContext.canonical_root !== inventoryAdmission.canonical_root
  ) {
    return failure("IDENTITY_MISMATCH", "admission.inventory_admission.authority_context.canonical_root", "Use inventory admission whose bound authority context carries the exact scheduler project root.");
  }
  const storageRun = validateWorkflowRunIdentity(admission.storage.run_identity);
  if (
    !isCanonicalRoot(admission.storage.project_root)
    || admission.storage.project_root !== projectRoot
    || !storageRun.ok
    || !sameRun(storageRun.value, run)
  ) {
    return failure("IDENTITY_MISMATCH", "admission.storage", "Use storage authority admitted for the exact scheduler project root and WorkflowRunIdentity.");
  }
  const inventory = validateFullstackInventoryAdmission(inventoryAdmission, undefined, run);
  if (!inventory.ok) return inventory;
  return inventory;
}


function stateRelative(run: WorkflowRunIdentity): string {
  return `.work-state/cto/${run.run_id}/state.json`;
}

function schedulerEnabled(state: CtoState, now = Date.now()): boolean {
  const scheduler = state.scheduler;
  if (!scheduler || typeof scheduler !== "object") return false;
  return shouldRunWave(
    {
      ...state,
      scheduler: { ...scheduler, last_wave_at: undefined },
    },
    now,
  );
}

function readPinnedState(storage: FullstackStorageAuthority, run: WorkflowRunIdentity): CtoState | null {
  const raw = storage.readJsonBounded(stateRelative(run), MAX_STATE_BYTES, MAX_JSON_DEPTH);
  if (!raw.ok || raw.value === null || typeof raw.value !== "object" || Array.isArray(raw.value)) return null;
  const candidate = raw.value as Partial<CtoState>;
  if (!candidate.plan || typeof candidate.plan !== "object" || Array.isArray(candidate.plan)) return null;
  const stateRun = validateWorkflowRunIdentity(candidate.run_identity);
  const planRun = validateWorkflowRunIdentity(candidate.plan.run_identity);
  if (
    !stateRun.ok
    || !planRun.ok
    || !sameRun(stateRun.value, run)
    || !sameRun(planRun.value, run)
    || candidate.id !== run.run_id
    || candidate.plan.id !== run.run_id
  ) return null;
  return candidate as CtoState;
}

function writePinnedState(storage: FullstackStorageAuthority, run: WorkflowRunIdentity, state: CtoState): boolean {
  if (!state || typeof state !== "object" || !state.plan || typeof state.plan !== "object" || Array.isArray(state.plan)) return false;
  const stateRun = validateWorkflowRunIdentity(state.run_identity);
  const planRun = validateWorkflowRunIdentity(state.plan.run_identity);
  if (
    !stateRun.ok
    || !planRun.ok
    || !sameRun(stateRun.value, run)
    || !sameRun(planRun.value, run)
    || state.id !== run.run_id
    || state.plan.id !== run.run_id
  ) return false;
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(state, null, 2));
  } catch {
    return false;
  }
  return storage.writeAtomic(stateRelative(run), bytes, MAX_STATE_BYTES).ok;
}

export function startCtoSchedulerDaemon(opts: CtoSchedulerDaemonOpts): DiagnosticResult<CtoSchedulerDaemonHandle> {
  if (!opts || !isCanonicalRoot(opts.project_root)) return failure("CAPABILITY_MISSING", "project_root", "Provide the manager-resolved canonical root before starting the scheduler.");
  if (typeof opts.onWave !== "function") return failure("CAPABILITY_MISSING", "scheduler.onWave", "Provide a callable wave executor before starting the scheduler.");
  const run = validateWorkflowRunIdentity(opts.run_identity);
  if (!run.ok) return run;
  const stateRun = validateWorkflowRunIdentity(opts.state?.run_identity);
  if (!stateRun.ok) return stateRun;
  const planRun = validateWorkflowRunIdentity(opts.state?.plan?.run_identity);
  if (!planRun.ok) return planRun;
  if (!sameRun(run.value, stateRun.value) || !sameRun(run.value, planRun.value) || opts.state.id !== run.value.run_id || opts.state.plan.id !== run.value.run_id) return failure("IDENTITY_MISMATCH", "state.run_identity", "Use one exact WorkflowRunIdentity for scheduler state, plan, and daemon input.");
  if (!isTrustedFsAuthority(opts.filesystem_authority)) return failure("CAPABILITY_MISSING", "filesystem_authority", "Provide the launcher-issued trusted filesystem authority before starting the scheduler.");
  if (!isFullstackStorageAuthority(opts.storage)) return failure("CAPABILITY_MISSING", "storage", "Provide the phase-3 pinned FullstackStorageAuthority before starting the scheduler.");
  const filesystemAuthority = opts.filesystem_authority;
  const storage = opts.storage;
  if (storage.project_root !== opts.project_root || !sameRun(storage.run_identity, run.value)) return failure("IDENTITY_MISMATCH", "storage", "Pin scheduler storage to the exact canonical root and WorkflowRunIdentity.");
  const inventoryAdmission = validateSchedulerAdmission(
    opts.admission,
    opts.project_root,
    run.value,
    filesystemAuthority,
    storage,
  );
  if (!inventoryAdmission.ok) return inventoryAdmission;
  const admissionNow = Date.now();
  if (!isPositiveDateSafeInterval(opts.intervalMs, admissionNow)) {
    return {
      ok: false,
      diagnostics: [schedulerIntervalDiagnostic("scheduler.intervalMs")],
    };
  }

  const initial = readPinnedState(storage, run.value);
  if (!initial) return failure("MIGRATION_REQUIRED", "state.json", "Persist an identity-bound scheduler state through the pinned storage capability before starting the daemon.");
  const initialInterval = initial.scheduler?.wave_interval_ms;
  if (isInvalidPersistedInterval(initialInterval, admissionNow)) {
    return {
      ok: false,
      diagnostics: [schedulerIntervalDiagnostic("scheduler.wave_interval_ms")],
    };
  }
  if (initial.scheduler === undefined) {
    initial.scheduler = { wave_interval_ms: opts.intervalMs };
    if (!writePinnedState(storage, run.value, initial)) {
      return failure("MIGRATION_REQUIRED", "state.json", "Persist the identity-bound scheduler configuration through the pinned storage capability before starting the daemon.");
    }
  }
  if (!schedulerEnabled(initial)) {
    return {
      ok: true,
      value: { stop: (): void => {} },
      diagnostics: [],
    };
  }

  const lease = storage.acquireLease(".omp/cto-scheduler.lock", run.value);
  if (!lease.ok) return failure(lease.reason === "MIGRATION_REQUIRED" ? "MIGRATION_REQUIRED" : lease.reason === "IDENTITY_MISMATCH" ? "IDENTITY_MISMATCH" : "CAPABILITY_MISSING", "scheduler.lease", lease.message ?? "Acquire the exact run-bound scheduler lease before starting.");
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    storage.releaseLease(lease.value.relative_path, run.value);
  };
  const tick = (): void => {
    if (stopped) return;
    const fresh = readPinnedState(storage, run.value);
    if (!fresh) return;
    const stampedAt = Date.now();
    const intervalMs = fresh.scheduler?.wave_interval_ms;
    if (!isPositiveDateSafeInterval(intervalMs, stampedAt)) {
      stop();
      if (isInvalidPersistedInterval(intervalMs, stampedAt)) {
        reportDiagnostic(opts.onDiagnostic, schedulerIntervalDiagnostic("scheduler.wave_interval_ms"));
      }
      return;
    }
    if (!schedulerEnabled(fresh, stampedAt)) {
      stop();
      return;
    }
    if (!shouldRunWave(fresh, stampedAt)) return;
    const nextWaveAtMs = stampedAt + intervalMs;
    const lastWaveAt = new Date(stampedAt).toISOString();
    const nextWaveAt = new Date(nextWaveAtMs).toISOString();
    try {
      opts.onWave();
    } catch {
      return;
    }
    if (stopped) return;
    const updated = readPinnedState(storage, run.value);
    if (!updated) return;
    const updatedInterval = updated.scheduler?.wave_interval_ms;
    if (!isPositiveDateSafeInterval(updatedInterval, stampedAt)) {
      stop();
      if (isInvalidPersistedInterval(updatedInterval, stampedAt)) {
        reportDiagnostic(opts.onDiagnostic, schedulerIntervalDiagnostic("scheduler.wave_interval_ms"));
      }
      return;
    }
    if (!schedulerEnabled(updated, stampedAt)) {
      stop();
      return;
    }
    updated.scheduler = {
      ...updated.scheduler,
      wave_interval_ms: updatedInterval,
      last_wave_at: lastWaveAt,
      next_wave_at: nextWaveAt,
    };
    const persisted = writePinnedState(storage, run.value, updated);
    if (!persisted) {
      stop();
      reportDiagnostic(opts.onDiagnostic, schedulerPersistenceFailureDiagnostic());
    }
  };
  timer = setInterval(tick, Math.min(opts.intervalMs, MAX_TIMER_INTERVAL_MS));
  timer.unref?.();
  return {
    ok: true,
    value: { stop },
    diagnostics: [],
  };
}
