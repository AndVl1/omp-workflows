import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  normalizePersistedState,
  resolveActiveBranch,
  resolveCanonicalRun,
  updateStateAtomically,
  withWorkspaceTransaction,
  withWorkspaceRead,
  type CanonicalRunTarget,
  type StatePublication,
} from "./state.js";
import { beginLifecycleTransaction, commitLifecycleTransaction, type LifecycleFileContent } from "./lifecycle-journal.js";
import { LifecycleError, lifecyclePayloadHash, selectRunCandidate } from "./run-lifecycle.js";
import type { RunSelectionInput, RunSelectionResult } from "./run-lifecycle.js";
import { isRecord, validateDispatchCapabilityValue, validatePrepareRequestReceiptValue } from "./control-plane-contract.js";
import type {
  LifecycleRequest,
  LifecycleStatus,
  OrdinaryRunIdentity,
  PrepareRequestReceipt,
  RunCandidate,
  RunControl,
  RunSelectionSnapshot,
  TeamState,
  TrustedExecutionContext,
  WorktreeExecutionClaim,
} from "./types.js";

const WORK_STATE = ".work-state";
const RUNS_DIR = "runs";
const CONTROL_FILE = "run-control.json";
const TRANSACTIONS_DIR = "lifecycle-transactions";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RunControlMutation<T> = (control: RunControl) => { commit: true; value: T; control?: RunControl } | { commit: false; value: T; control?: RunControl };

function controlPath(cwd: string): string {
  return join(resolve(cwd, WORK_STATE), CONTROL_FILE);
}

function defaultControl(): RunControl {
  return { schema: 2, revision: 0, runs: {}, selections: {}, execution_claim: null, prepare_receipts: {}, selection_snapshots: {} };
}

function validRunId(runId: string): boolean {
  return UUID.test(runId) && !runId.includes("/") && !runId.includes("\\");
}

function ensureRunId(runId: string): void {
  if (!validRunId(runId)) throw new LifecycleError("run_state_invalid", `invalid ordinary run id '${runId}'`, { run_id: runId });
}

function ensureClaimId(runId: string, ownerKind: "workflow" | "cto"): void {
  if (ownerKind === "workflow") ensureRunId(runId);
  else if (!runId || !/^[A-Za-z0-9._-]+$/.test(runId)) throw new LifecycleError("run_state_invalid", "invalid CTO claim id", { run_id: runId });
}

function receiptBindingIssues(
  cwd: string,
  control: RunControl,
  requestId: string,
  receipt: unknown,
  verifyCanonicalState = true,
): string[] {
  const issues: string[] = [];
  const shape = validatePrepareRequestReceiptValue(receipt, `$.prepare_receipts.${requestId}`);
  if (!shape.ok) issues.push(...shape.issues.map((issue) => `${issue.path} ${issue.message}`));
  if (!isRecord(receipt)) return issues;
  if (receipt.request_id !== requestId) issues.push(`$.prepare_receipts.${requestId}.request_id must equal its map key`);
  const descriptors: Array<{ label: "previous" | "selected"; runId: unknown; title: unknown; status: unknown }> = [
    { label: "previous", runId: receipt.previous_run_id, title: receipt.previous_title, status: receipt.previous_status },
    { label: "selected", runId: receipt.selected_run_id, title: receipt.selected_title, status: receipt.selected_status },
  ];
  for (const descriptor of descriptors) {
    if (descriptor.label === "previous" && descriptor.runId === null) continue;
    if (typeof descriptor.runId !== "string" || !validRunId(descriptor.runId)) continue;
    const indexed = control.runs[descriptor.runId];
    const historicalSameRun = descriptor.label === "previous" && receipt.selected_run_id === descriptor.runId;
    const compare = (candidate: RunCandidate, source: string): void => {
      if (candidate.run_id !== descriptor.runId) issues.push(`${source}.run_id does not match ${descriptor.label}_run_id`);
      if (!verifyCanonicalState && !historicalSameRun && candidate.title !== descriptor.title) {
        issues.push(`${source}.title does not match ${descriptor.label}_title`);
      }
    };
    if (indexed) compare(indexed, `$.runs.${descriptor.runId}`);
    let canonical: RunCandidate | null = null;
    if (verifyCanonicalState) {
      if (!existsSync(runStatePath(cwd, descriptor.runId))) {
        issues.push(`${descriptor.label} run '${descriptor.runId}' canonical state is missing`);
      } else {
        try {
          const resolved = resolveCanonicalRun(cwd, { kind: "team", runId: descriptor.runId });
          if (!resolved?.state) issues.push(`${descriptor.label} run '${descriptor.runId}' state is unavailable`);
          else canonical = candidateForState(resolved.state);
        } catch (error) {
          issues.push(`${descriptor.label} run '${descriptor.runId}' state is invalid: ${(error as Error).message}`);
        }
      }
    }
    if (!indexed && !canonical) issues.push(`${descriptor.label} run '${descriptor.runId}' is absent from the canonical run index and state`);
    if (canonical) compare(canonical, `canonical state '${descriptor.runId}'`);
  }
  return issues;
}

function assertReceiptBinding(cwd: string, control: RunControl, requestId: string, receipt: unknown, verifyCanonicalState = true): asserts receipt is PrepareRequestReceipt {
  const issues = receiptBindingIssues(cwd, control, requestId, receipt, verifyCanonicalState);
  if (issues.length > 0) {
    throw new LifecycleError("recovery_required", `run-control prepare receipt '${requestId}' is invalid: ${issues.join("; ")}`, { next_action: "repair or recover the lifecycle control plane before mutating" });
  }
}

function readControlRaw(cwd: string): RunControl {
  const path = controlPath(cwd);
  if (!existsSync(path)) return defaultControl();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LifecycleError("recovery_required", `run-control.json is unreadable: ${(error as Error).message}`, { next_action: "recover lifecycle transaction before mutating" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LifecycleError("recovery_required", "run-control.json is not an object", { next_action: "recover lifecycle transaction before mutating" });
  const value = parsed as Partial<RunControl>;
  const revision = value.revision;
  if (value.schema !== 2 || !Number.isInteger(revision) || (revision as number) < 0
    || !isRecord(value.runs) || !isRecord(value.selections) || !isRecord(value.prepare_receipts) || !isRecord(value.selection_snapshots)) {
    throw new LifecycleError("recovery_required", "run-control.json has an unknown schema or incomplete fields", { next_action: "recover lifecycle transaction before mutating" });
  }
  const control = { ...defaultControl(), ...value, schema: 2 } as RunControl;
  for (const [requestId, receipt] of Object.entries(value.prepare_receipts)) {
    assertReceiptBinding(cwd, control, requestId, receipt);
  }
  return control;
}

function claimCoordinatorIsBusy(claim: WorktreeExecutionClaim, context: TrustedExecutionContext): boolean {
  if (claim.coordinator_session_id === context.session_id && !claim.released_at) return false;
  if (claim.released_at) return claim.worker_ids.length > 0;
  if (!claim.coordinator_process_id) return true;
  try {
    process.kill(claim.coordinator_process_id, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function controlContent(cwd: string): string | null {
  const path = controlPath(cwd);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function writeControlTransaction(
  cwd: string,
  before: string | null,
  next: RunControl,
  operation: "new" | "resume" | "rework" | "migration" | "claim" = "claim",
): void {
  const after = `${JSON.stringify(next, null, 2)}\n`;
  const transaction = beginLifecycleTransaction({
    cwd,
    operation,
    before: { [controlPath(cwd)]: before },
    after: { [controlPath(cwd)]: after },
  });
  commitLifecycleTransaction(cwd, transaction.transaction_id);
}

export function readRunControl(cwd: string): RunControl {
  return withWorkspaceRead(cwd, () => readControlRaw(cwd), () => defaultControl());
}

export function updateRunControl<T>(cwd: string, mutate: RunControlMutation<T>): T {
  return withWorkspaceTransaction(cwd, () => {
    const before = controlContent(cwd);
    const current = readControlRaw(cwd);
    const result = mutate(current);
    if (result.commit) {
      const next = { ...(result.control ?? current), revision: current.revision + 1 };
      writeControlTransaction(cwd, before, next);
    }
    return result.value;
  });
}

export function runTarget(cwd: string, runId: string): CanonicalRunTarget {
  ensureRunId(runId);
  const root = resolve(cwd, WORK_STATE, RUNS_DIR, runId);
  return {
    state: null,
    statePath: join(root, "state.json"),
    stateDir: root,
    artifactsDir: join(root, "artifacts"),
    isLegacy: false,
    isStale: false,
    canonicalRun: true,
    schema: 2,
    runId,
    runKey: runId,
    branch: resolveActiveBranch(cwd),
  };
}
export function runStatePath(cwd: string, runId: string): string {
  return runTarget(cwd, runId).statePath;
}

export function readRunState(cwd: string, runId: string, currentBranch?: string): TeamState | null {
  return withWorkspaceRead(cwd, () => {
    const resolved = resolveCanonicalRun(cwd, { kind: "team", runId }, currentBranch);
    return resolved?.state ?? null;
  }, () => null);
}

function lifecycleStatus(state: TeamState): LifecycleStatus {
  if (state.lifecycle_status) return state.lifecycle_status;
  if (state.pause.kind === "done") return "complete";
  if (state.pause.kind === "failed") return "failed";
  if (state.pause.kind !== "none") return "paused";
  return "active";
}

export function candidateForState(state: TeamState): RunCandidate {
  return {
    run_id: state.run_id ?? state.run_key ?? "",
    title: state.title ?? state.task,
    task: state.task,
    branch: state.branch,
    status: lifecycleStatus(state),
    stage: state.stage_cursor,
    updated_at: state.updated_at,
    rework_generation: state.rework_generation ?? 0,
  };
}
function transitionReceiptForSnapshots(
  receipt: PrepareRequestReceipt,
  previous: RunCandidate | null,
  selected: RunCandidate,
): PrepareRequestReceipt {
  return {
    ...receipt,
    previous_run_id: previous?.run_id ?? null,
    previous_title: previous?.title ?? null,
    previous_status: previous?.status ?? null,
    selected_run_id: selected.run_id,
    selected_title: selected.title,
    selected_status: selected.status,
    continuation: { stage: selected.stage, status: selected.status },
  };
}

function listRunsUnsafe(cwd: string, options: { branch?: string; includeTerminal?: boolean } = {}): RunCandidate[] {
  const root = join(resolve(cwd, WORK_STATE), RUNS_DIR);
  if (!existsSync(root)) return [];
  const candidates: RunCandidate[] = [];
  for (const runId of readdirSync(root)) {
    if (!validRunId(runId)) continue;
    const statePath = join(root, runId, "state.json");
    try {
      if (!statSync(statePath).isFile()) throw new Error("state.json is not a regular file");
      const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("state is not an object");
      const state = parsed as TeamState;
      if (state.schema !== 2 || state.run_id !== runId || state.run_key !== runId) throw new Error("schema-2 run identity is invalid");
      if (options.branch && state.branch !== options.branch) continue;
      const candidate = candidateForState(state);
      if (!options.includeTerminal && candidate.status === "complete") continue;
      candidates.push(candidate);
    } catch (error) {
      throw new LifecycleError("recovery_required", `canonical run '${runId}' is malformed: ${(error as Error).message}`, { run_id: runId, next_action: "repair or recover the canonical run before listing or selecting it" });
    }
  }
  return candidates.sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.run_id.localeCompare(b.run_id));
}

export function listRuns(cwd: string, options: { branch?: string; includeTerminal?: boolean } = {}): RunCandidate[] {
  return withWorkspaceRead(cwd, () => listRunsUnsafe(cwd, options), () => []);
}

export interface DispatchLocator {
  run_id: string;
  dispatch_id: string;
  origin_session_id?: string;
  completed: boolean;
}
export interface DispatchOrigin {
  cwd: string;
  run_id: string;
  dispatch_id: string;
  origin_session_id?: string;
  capability_id?: string;
  stage_id?: string;
  cursor_epoch?: string;
  slot_id?: string;
  task_id?: string;
}

export interface DispatchOriginFilter {
  runId: string;
  capabilityId?: string;
  stageId?: string;
  cursorEpoch?: string;
  slotId?: string;
  taskId?: string;
}

const dispatchOriginRegistry = new Map<string, DispatchOrigin[]>();

export function rememberDispatchOrigin(toolCallId: string, origin: DispatchOrigin): void {
  if (!toolCallId || !validRunId(origin.run_id)) return;
  const key = resolve(origin.cwd) + "|" + origin.run_id + "|" + origin.dispatch_id;
  const existing = dispatchOriginRegistry.get(toolCallId) ?? [];
  if (!existing.some((entry) => resolve(entry.cwd) + "|" + entry.run_id + "|" + entry.dispatch_id === key)) {
    existing.push({ ...origin, cwd: resolve(origin.cwd) });
    dispatchOriginRegistry.set(toolCallId, existing);
  }
}

/** Restore only canonical dispatch origins from a trusted workspace/run path. */
export function restoreDispatchOrigins(cwd: string, runId: string): void {
  if (!validRunId(runId)) return;
  const workspace = resolve(cwd);
  const target = runTarget(workspace, runId);
  const statePath = resolve(target.statePath!);
  const relativePath = relative(workspace, statePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(".." + sep) || isAbsolute(relativePath)) return;
  const state = readRunState(workspace, runId);
  if (!state || state.schema !== 2 || state.run_id !== runId || state.run_key !== runId) return;
  for (const dispatch of state.dispatch_capability?.dispatches ?? []) {
    if (!dispatch.tool_call_id) continue;
    rememberDispatchOrigin(dispatch.tool_call_id, {
      cwd: workspace,
      run_id: runId,
      dispatch_id: dispatch.id,
      ...(dispatch.origin_session_id ? { origin_session_id: dispatch.origin_session_id } : {}),
      ...(dispatch.work_identity ? {
        capability_id: dispatch.work_identity.capability_id,
        stage_id: dispatch.work_identity.stage_id,
        cursor_epoch: dispatch.work_identity.capability_epoch,
        slot_id: dispatch.work_identity.slot_id,
        task_id: dispatch.work_identity.task_id,
      } : {}),
    });
  }
}

export function knownDispatchOrigins(toolCallId: string, filter?: DispatchOriginFilter): DispatchOrigin[] {
  const matches = (dispatchOriginRegistry.get(toolCallId) ?? []).filter((entry) => !filter
    || (entry.run_id === filter.runId
      && (!filter.capabilityId || entry.capability_id === filter.capabilityId)
      && (!filter.stageId || entry.stage_id === filter.stageId)
      && (!filter.cursorEpoch || entry.cursor_epoch === filter.cursorEpoch)
      && (!filter.slotId || entry.slot_id === filter.slotId)
      && (!filter.taskId || entry.task_id === filter.taskId)));
  const groups = new Set(matches.map((entry) => entry.cwd + "|" + entry.run_id + "|" + (entry.origin_session_id ?? "")));
  // A native result may reconcile every slot in one authorized batch, but
  // never slots from different immutable origins. Current callback session/cwd
  // are intentionally ignored because late results can cross host sessions.
  if (groups.size !== 1) return [];
  return matches.map((entry) => ({ ...entry }));
}


/** Locate every exact native task slot without consulting current selection. */
export function locateDispatchesByToolCall(cwd: string, toolCallId: string, originSessionId?: string): DispatchLocator[] {
  if (!toolCallId) return [];
  const matches: DispatchLocator[] = [];
  for (const candidate of listRuns(cwd, { includeTerminal: true })) {
    const state = readRunState(cwd, candidate.run_id, candidate.branch);
    for (const dispatch of state?.dispatch_capability?.dispatches ?? []) {
      if (dispatch.tool_call_id !== toolCallId) continue;
      if (originSessionId && dispatch.origin_session_id !== originSessionId) continue;
      matches.push({ run_id: candidate.run_id, dispatch_id: dispatch.id, ...(dispatch.origin_session_id ? { origin_session_id: dispatch.origin_session_id } : {}), completed: Boolean(dispatch.completion) });
    }
  }
  if (!originSessionId && new Set(matches.map((match) => match.run_id)).size !== 1) return [];
  return matches;
}

/** Locate one exact slot; retained as a compatibility convenience, never a guessing fallback. */
export function locateDispatchByToolCall(cwd: string, toolCallId: string, originSessionId?: string): DispatchLocator | null {
  const matches = locateDispatchesByToolCall(cwd, toolCallId, originSessionId);
  return matches.length === 1 ? matches[0]! : null;
}

const selectionSnapshots = new Map<string, RunSelectionSnapshot>();

export function readSelectionSnapshot(cwd: string, snapshotId: string): RunSelectionSnapshot | undefined {
  const snapshot = selectionSnapshots.get(resolve(cwd) + ":" + snapshotId);
  return snapshot ? structuredClone(snapshot) : undefined;
}

export function createSelectionSnapshot(cwd: string, options: { branch?: string; includeTerminal?: boolean } = {}): RunSelectionSnapshot {
  return withWorkspaceRead(cwd, () => {
    const snapshot: RunSelectionSnapshot = {
      snapshot_id: randomUUID(),
      created_at: new Date().toISOString(),
      branch: options.branch ?? null,
      candidates: listRunsUnsafe(cwd, options),
    };
    // No run-control mutation is performed. This process-local snapshot is
    // naturally lost on restart, requiring the host to list again.
    selectionSnapshots.set(resolve(cwd) + ":" + snapshot.snapshot_id, snapshot);
    return structuredClone(snapshot);
  }, () => {
    const snapshot: RunSelectionSnapshot = { snapshot_id: randomUUID(), created_at: new Date().toISOString(), branch: options.branch ?? null, candidates: [] };
    selectionSnapshots.set(resolve(cwd) + ":" + snapshot.snapshot_id, snapshot);
    return structuredClone(snapshot);
  });
}
export function resolveRunSelection(input: RunSelectionInput): RunSelectionResult {
  return selectRunCandidate(input);
}
function hasOutstandingDispatches(cwd: string, runId: string, ownerKind: "workflow" | "cto" = "workflow"): boolean | null {
  // CTO ids are a separate slug namespace and have no ordinary run state.
  if (ownerKind === "cto") return false;
  try {
    const path = runStatePath(cwd, runId);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    // A claim may be released only from a complete canonical schema-2 state
    // whose identity names the claimed run. Parseable but structurally invalid
    // JSON is unknown/busy, never an empty dispatch ledger.
    if (state.schema !== 2 || state.run_id !== runId || state.run_key !== runId
      || typeof state.branch !== "string" || !state.branch
      || !Array.isArray(state.stages) || typeof state.stage_cursor !== "string"
      || !Number.isInteger(state.state_revision) || typeof state.updated_at !== "string") return null;
    if (state.dispatch_capability !== undefined) {
      const capability = validateDispatchCapabilityValue(state.dispatch_capability);
      if (!capability.ok) return null;
      const dispatches = (state.dispatch_capability as { dispatches?: unknown }).dispatches;
      if (!Array.isArray(dispatches)) return null;
    }
    const dispatches = (state.dispatch_capability as { dispatches?: Array<{ status?: string; completion?: unknown }> } | undefined)?.dispatches ?? [];
    return dispatches.some((dispatch) => !dispatch.completion && ["authorized", "running", "pending", "transport_reconnect"].includes(dispatch.status ?? ""));
  } catch {
    // Unreadable canonical state is unknown/busy, never proof of quiescence.
    return null;
  }
}

function claimBusy(claim: WorktreeExecutionClaim, context: TrustedExecutionContext): boolean {
  if (claim.coordinator_session_id === context.session_id && !claim.released_at) return false;
  if (claim.released_at) return claim.worker_ids.length > 0;
  if (!claim.coordinator_process_id) return true;
  try {
    process.kill(claim.coordinator_process_id, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export interface ClaimResult { claim: WorktreeExecutionClaim; idempotent: boolean }

export function acquireExecutionClaim(cwd: string, input: { run_id: string; context: TrustedExecutionContext; owner_kind?: "workflow" | "cto"; worker_ids?: string[] }): ClaimResult {
  ensureClaimId(input.run_id, input.owner_kind ?? "workflow");
  return withWorkspaceTransaction(cwd, () => {
    const before = controlContent(cwd);
    const control = readControlRaw(cwd);
    const current = control.execution_claim;
    const outstanding = current ? hasOutstandingDispatches(cwd, current.run_id, current.owner_kind) : false;
    if (current && (current.run_id !== input.run_id || claimBusy(current, input.context) || outstanding !== false)) {
      throw new LifecycleError("run_busy", `worktree execution is owned by run '${current.run_id}'`, { run_id: current.run_id, next_action: current.run_id === input.run_id ? "resume or reconcile the existing run" : "wait for the owner or choose another worktree" });
    }
    if (current && current.run_id === input.run_id && current.coordinator_session_id === input.context.session_id && !current.released_at) {
      return { claim: current, idempotent: true };
    }
    const claim: WorktreeExecutionClaim = {
      token: randomUUID(),
      owner_kind: input.owner_kind ?? "workflow",
      run_id: input.run_id,
      coordinator_session_id: input.context.session_id,
      ...(input.context.process_id ? { coordinator_process_id: input.context.process_id } : {}),
      ownership_epoch: randomUUID(),
      worker_ids: [...new Set(input.worker_ids ?? current?.worker_ids ?? [])],
      released_at: null,
    };
    writeControlTransaction(cwd, before, { ...control, revision: control.revision + 1, execution_claim: claim }, "claim");
    return { claim, idempotent: false };
  });
}

export function releaseExecutionClaim(cwd: string, input: { run_id: string; token: string; receipt?: string }): void {
  if (!input.token) throw new LifecycleError("run_busy", "execution claim release requires the trusted ownership token", { run_id: input.run_id });
  withWorkspaceTransaction(cwd, () => {
    const before = controlContent(cwd);
    const control = readControlRaw(cwd);
    const claim = control.execution_claim;
    ensureClaimId(input.run_id, claim?.owner_kind ?? "workflow");
    if (!claim || claim.run_id !== input.run_id) return;
    if (claim.token !== input.token) throw new LifecycleError("run_busy", "execution claim token does not match", { run_id: input.run_id });
    const released = {
      ...claim,
      released_at: new Date().toISOString(),
      ...(input.receipt ? { release_receipt: input.receipt } : {}),
    };
    const outstanding = hasOutstandingDispatches(cwd, claim.run_id, claim.owner_kind);
    if (outstanding === null) throw new LifecycleError("recovery_required", "cannot release execution claim while canonical worker state is unreadable", { run_id: claim.run_id, next_action: "repair or reconcile the canonical run before releasing ownership" });
    writeControlTransaction(cwd, before, { ...control, revision: control.revision + 1, execution_claim: (claim.worker_ids.length > 0 || outstanding) ? released : null }, "claim");
  });
}

export function handoverExecutionClaim(cwd: string, input: { run_id: string; context: TrustedExecutionContext; token: string; release_receipt?: string }): ClaimResult {
  if (!input.token) throw new LifecycleError("run_busy", "execution claim handover requires the trusted ownership token", { run_id: input.run_id });
  return withWorkspaceTransaction(cwd, () => {
    const before = controlContent(cwd);
    const control = readControlRaw(cwd);
    const current = control.execution_claim;
    if (!current) {
      throw new LifecycleError("run_busy", "cannot hand over an execution claim that is not persisted", { run_id: input.run_id, next_action: "acquire the claim for a new coordinator" });
    }
    ensureClaimId(input.run_id, current.owner_kind);
    if (current.run_id !== input.run_id) {
      throw new LifecycleError("run_busy", `worktree execution is owned by run '${current.run_id}'`, { run_id: current.run_id });
    }
    if (current.token !== input.token) {
      throw new LifecycleError("run_busy", "execution claim token does not match", { run_id: input.run_id });
    }
    if (!current.released_at && claimBusy(current, input.context)) {
      throw new LifecycleError("run_busy", `coordinator for run '${input.run_id}' is still live`, { run_id: input.run_id, next_action: "wait for a release receipt or reconcile the owner" });
    }
    const claim: WorktreeExecutionClaim = {
      ...current,
      token: randomUUID(),
      coordinator_session_id: input.context.session_id,
      ...(input.context.process_id ? { coordinator_process_id: input.context.process_id } : {}),
      ownership_epoch: randomUUID(),
      released_at: null,
      ...(input.release_receipt ? { release_receipt: input.release_receipt } : {}),
    };
    writeControlTransaction(cwd, before, { ...control, revision: control.revision + 1, execution_claim: claim }, "claim");
    return { claim, idempotent: false };
  });
}

function transactionDir(cwd: string, transactionId: string): string {
  return join(resolve(cwd, WORK_STATE), TRANSACTIONS_DIR, transactionId);
}

export interface CanonicalRunCommitOptions {
  context?: TrustedExecutionContext;
  request?: LifecycleRequest;
  receipt?: PrepareRequestReceipt;
}

function authoritativeSessionCandidate(cwd: string, control: RunControl, context: TrustedExecutionContext, currentRunId: string): RunCandidate | null {
  const selection = control.selections[context.session_id];
  if (!selection || selection.run_id === currentRunId) return null;
  if (!validRunId(selection.run_id)) {
    throw new LifecycleError("recovery_required", `session '${context.session_id}' selects an invalid canonical run '${selection.run_id}'`, { next_action: "repair or recover the lifecycle control plane before mutating" });
  }
  const indexed = control.runs[selection.run_id];
  if (!existsSync(runStatePath(cwd, selection.run_id))) {
    throw new LifecycleError("recovery_required", `session '${context.session_id}' selects missing canonical run '${selection.run_id}'`, { run_id: selection.run_id, next_action: "repair or recover the lifecycle control plane before mutating" });
  }
  try {
    const resolved = resolveCanonicalRun(cwd, { kind: "team", runId: selection.run_id });
    if (!resolved?.state) throw new Error("canonical state is unavailable");
    const candidate = candidateForState(resolved.state);
    if (indexed && (indexed.title !== candidate.title || indexed.branch !== candidate.branch)) {
      throw new Error("canonical run index does not match its state");
    }
    return candidate;
  } catch (error) {
    throw new LifecycleError("recovery_required", `session '${context.session_id}' selection is invalid: ${(error as Error).message}`, { run_id: selection.run_id, next_action: "repair or recover the selected canonical run before mutating" });
  }
}

export function persistCanonicalRun(cwd: string, state: TeamState, options: CanonicalRunCommitOptions = {}): { target: CanonicalRunTarget; state: TeamState } {
  if (Boolean(options.request) !== Boolean(options.receipt)) {
    throw new LifecycleError("lifecycle_request_conflict", "lifecycle request and receipt must be supplied together");
  }
  if (options.request && (options.request.mode !== "new" || options.receipt!.operation !== "new" || options.receipt!.request_id !== options.request.request_id)) {
    throw new LifecycleError("lifecycle_request_conflict", "persistCanonicalRun accepts only a matching new lifecycle request and receipt");
  }
  if (state.schema !== 2 || !state.run_id || state.run_key !== state.run_id) throw new LifecycleError("run_state_invalid", "schema-2 canonical run requires matching run_id and run_key");
  return withWorkspaceTransaction(cwd, () => {
    const runId = state.run_id;
    if (!runId) throw new LifecycleError("run_state_invalid", "schema-2 canonical run requires run_id");
    const target = runTarget(cwd, runId);
    const statePath = target.statePath!;
    const beforeControl = controlContent(cwd);
    const control = readControlRaw(cwd);
    const requestHash = options.request ? lifecyclePayloadHash(options.request) : null;
    const existing = options.request ? control.prepare_receipts[options.request.request_id] : undefined;
    if (existing) {
      if (existing.payload_hash !== requestHash) {
        throw new LifecycleError("lifecycle_request_conflict", "request_id replayed with a different payload", { run_id: existing.selected_run_id });
      }
      const existingTarget = runTarget(cwd, existing.selected_run_id);
      if (!existsSync(existingTarget.statePath!)) {
        throw new LifecycleError("recovery_required", "exact replay receipt points to a missing canonical run", { run_id: existing.selected_run_id });
      }
      const existingState = JSON.parse(readFileSync(existingTarget.statePath!, "utf8")) as TeamState;
      if (options.receipt) Object.assign(options.receipt, existing);
      return { target: { ...existingTarget, state: existingState }, state: existingState };
    }
    if (existsSync(statePath)) throw new LifecycleError("lifecycle_request_conflict", `run '${state.run_id}' already exists`, { run_id: state.run_id });
    let claim = control.execution_claim;
    let previousCandidate: RunCandidate | null = null;
    if (options.context) {
      if (claim && claim.run_id !== runId) {
        const sameSession = claim.coordinator_session_id === options.context.session_id && !claim.released_at;
        const previous = sameSession ? resolveCanonicalRun(cwd, { kind: "team", runId: claim.run_id }) : null;
        const previousState = previous?.state;
        if (previousState) previousCandidate = candidateForState(previousState);
        const previousPending = Boolean(previousState?.pending)
          || (previousState?.dispatch_capability?.pending?.some((entry) => entry.status === "authorized" || entry.status === "running" || entry.status === "pending") ?? false)
          || (previousState?.dispatch_capability?.dispatches?.some((entry) => entry.status === "authorized" || entry.status === "running" || entry.status === "pending") ?? false);
        if (!sameSession || previousState === null || previousPending || claimBusy(claim, options.context)) {
          throw new LifecycleError("run_busy", `worktree execution is owned by run ${claim.run_id}`, { run_id: claim.run_id });
        }
      } else if (claim && claimBusy(claim, options.context)) {
        throw new LifecycleError("run_busy", `worktree execution is owned by run ${claim.run_id}`, { run_id: claim.run_id });
      }
      if (!claim || claim.run_id !== runId || claim.coordinator_session_id !== options.context.session_id || claim.released_at) {
        claim = {
          token: randomUUID(),
          owner_kind: "workflow",
          run_id: runId,
          coordinator_session_id: options.context.session_id,
          ...(options.context.process_id ? { coordinator_process_id: options.context.process_id } : {}),
          ownership_epoch: randomUUID(),
          worker_ids: [],
          released_at: null,
        };
      }
      if (!previousCandidate) previousCandidate = authoritativeSessionCandidate(cwd, control, options.context, runId);
    }
    const committedState: TeamState = { ...state, state_revision: 1 };
    const stateContent = `${JSON.stringify(committedState, null, 2)}\n`;
    const selectedCandidate = candidateForState(committedState);
    const committedReceipt = options.request && options.receipt
      ? {
          ...transitionReceiptForSnapshots(options.receipt, options.request.mode === "new" ? previousCandidate : null, selectedCandidate),
          payload_hash: lifecyclePayloadHash(options.request),
        }
      : null;
    const nextControl: RunControl = {
      ...control,
      revision: control.revision + 1,
      execution_claim: claim,
      runs: { ...control.runs, [runId]: selectedCandidate },
      ...(options.context
        ? { selections: {
            ...Object.fromEntries(Object.entries(control.selections).map(([sessionId, selection]) => [sessionId, selection.run_id === runId ? { ...selection, active: false } : selection])),
            [options.context.session_id]: { run_id: runId, branch: state.branch, selected_at: new Date().toISOString(), active: true },
          } }
        : {}),
      ...(committedReceipt
        ? { prepare_receipts: { ...control.prepare_receipts, [options.request!.request_id]: committedReceipt } }
        : {}),
    };
    if (committedReceipt) assertReceiptBinding(cwd, nextControl, options.request!.request_id, committedReceipt, false);
    const controlContentAfter = `${JSON.stringify(nextControl, null, 2)}\n`;
    const transaction = beginLifecycleTransaction({
      cwd,
      operation: options.request?.mode ?? "new",
      before: { [statePath]: null, [controlPath(cwd)]: beforeControl },
      after: { [statePath]: stateContent, [controlPath(cwd)]: controlContentAfter },
    });
    commitLifecycleTransaction(cwd, transaction.transaction_id);
    if (committedReceipt && options.receipt) Object.assign(options.receipt, committedReceipt);
    return {
      target: { ...target, state: committedState },
      state: committedState,
    };
  });
}
export function updateCanonicalRun(cwd: string, runId: string, mutate: (state: TeamState) => TeamState): TeamState {
  ensureRunId(runId);
  const result = updateStateAtomically(cwd, (snapshot) => {
    if (!snapshot.state) return { op: "fail", code: "state_missing", error: `run '${runId}' is missing` };
    if (snapshot.state.schema !== 2 || snapshot.state.run_id !== runId || snapshot.state.run_key !== runId) {
      return { op: "fail", code: "state_invalid", error: "canonical run identity is invalid" };
    }
    return { op: "commit", state: mutate(snapshot.state) };
  }, { target: runTarget(cwd, runId), branch: resolveActiveBranch(cwd) });
  if (!result.ok) {
    const code = result.code === "state_missing" ? "run_not_found" : result.code === "recovery_required" ? "recovery_required" : "run_state_invalid";
    throw new LifecycleError(code, result.error, { run_id: runId });
  }
  if (!result.state) throw new LifecycleError("run_state_invalid", "canonical run transaction committed without state", { run_id: runId });
  return result.state;
}
export function reworkCanonicalRunAtomically(
  cwd: string,
  runId: string,
  mutate: (state: TeamState) => TeamState,
  request: LifecycleRequest,
  receipt: PrepareRequestReceipt,
  options: { context?: TrustedExecutionContext; ownershipToken?: string; invalidateOwnedFiles?: (current: TeamState, next: TeamState) => string[] } = {},
): TeamState {
  ensureRunId(runId);
  if (request.mode !== "rework" || receipt.operation !== "rework" || request.run_id !== runId || receipt.request_id !== request.request_id) {
    throw new LifecycleError("lifecycle_request_conflict", "reworkCanonicalRunAtomically requires a matching rework request and receipt", { run_id: runId });
  }
  return withWorkspaceTransaction(cwd, () => {
    const controlPathValue = controlPath(cwd);
    const controlBefore = controlContent(cwd);
    const target = runTarget(cwd, runId);
    const statePath = target.statePath!;
    const stateRaw = readFileSync(statePath, "utf8");
    const current = JSON.parse(stateRaw) as TeamState;
    if (current.schema !== 2 || current.run_id !== runId || current.run_key !== runId) throw new LifecycleError("run_state_invalid", "canonical rework identity is invalid", { run_id: runId });
    if (request.branch !== current.branch) throw new LifecycleError("run_context_mismatch", "rework run '" + runId + "' belongs to branch '" + current.branch + "'", { run_id: runId, branch: current.branch });
    const control = readControlRaw(cwd);
    const requestHash = lifecyclePayloadHash(request);
    const existing = control.prepare_receipts[request.request_id];
    if (existing) {
      if (existing.payload_hash !== requestHash) {
        throw new LifecycleError("lifecycle_request_conflict", "request_id replayed with a different payload", { run_id: existing.selected_run_id });
      }
      Object.assign(receipt, existing);
      return current;
    }
    const claim = control.execution_claim;
    let publishedClaim = claim;
    let ownershipToken = options.ownershipToken;
    if (options.context) {
      if (claim && claim.run_id !== runId) throw new LifecycleError("run_busy", "worktree execution is owned by run '" + claim.run_id + "'", { run_id: claim.run_id });
      if (claim) {
        if (ownershipToken && claim.token !== ownershipToken) throw new LifecycleError("run_busy", "rework ownership changed before the atomic publication", { run_id: runId });
        const reusable = claim.coordinator_session_id === options.context.session_id && !claim.released_at;
        if (!ownershipToken && reusable) {
          ownershipToken = claim.token;
        } else if (!ownershipToken) {
          if (claimCoordinatorIsBusy(claim, options.context)) {
            throw new LifecycleError("run_busy", "rework ownership is still live; wait for a release receipt or reconcile the owner", { run_id: runId });
          }
          ownershipToken = randomUUID();
          publishedClaim = {
            ...claim,
            token: ownershipToken,
            coordinator_session_id: options.context.session_id,
            ...(options.context.process_id ? { coordinator_process_id: options.context.process_id } : {}),
            ownership_epoch: randomUUID(),
            worker_ids: [],
            released_at: null,
          };
        }
      } else {
        ownershipToken = randomUUID();
        publishedClaim = {
          token: ownershipToken,
          owner_kind: "workflow",
          run_id: runId,
          coordinator_session_id: options.context.session_id,
          ...(options.context.process_id ? { coordinator_process_id: options.context.process_id } : {}),
          ownership_epoch: randomUUID(),
          worker_ids: [],
          released_at: null,
        };
      }
      const pending = hasOutstandingDispatches(cwd, runId, claim?.owner_kind ?? "workflow");
      if (pending === null) throw new LifecycleError("recovery_required", "rework cannot verify dispatch quiescence", { run_id: runId });
      if (pending || (claim?.worker_ids.length ?? 0) > 0) throw new LifecycleError("run_busy", "rework requires all dispatch workers to be reconciled", { run_id: runId });
      if (publishedClaim && ownershipToken && publishedClaim.token !== ownershipToken) {
        publishedClaim = {
          ...publishedClaim,
          token: ownershipToken,
          coordinator_session_id: options.context.session_id,
          ...(options.context.process_id ? { coordinator_process_id: options.context.process_id } : {}),
          ownership_epoch: randomUUID(),
          released_at: null,
        };
      }
    }
    const nextState = mutate(current);
    if (nextState.schema !== 2 || nextState.run_id !== runId || nextState.run_key !== runId) throw new LifecycleError("run_state_invalid", "rework mutation produced invalid canonical identity", { run_id: runId });
    const source = join(resolve(cwd, WORK_STATE, RUNS_DIR, runId));
    const ownedFiles = new Set<string>();
    for (const candidate of options.invalidateOwnedFiles?.(current, nextState) ?? []) {
      if (!candidate || !isAbsolute(candidate)) continue;
      const absolute = resolve(candidate);
      const rel = relative(resolve(source, "artifacts"), absolute);
      if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) continue;
      ownedFiles.add(absolute);
    }
    const revisionId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID()}`;
    const revisionRoot = join(source, "revisions", revisionId);
    const stateContent: LifecycleFileContent = stateRaw;
    const files = collectSnapshotFiles(source, { "state.json": stateContent });
    const after: Record<string, LifecycleFileContent> = { [statePath]: `${JSON.stringify(nextState, null, 2)}\n` };
    const artifactSha256: Record<string, string> = {};
    for (const [relativePath, content] of Object.entries(files)) {
      if (relativePath.startsWith("revisions/")) continue;
      after[join(revisionRoot, relativePath)] = content;
      if (relativePath.startsWith("artifacts/")) artifactSha256[relativePath.slice("artifacts/".length)] = createHash("sha256").update(lifecycleContentBytes(content)).digest("hex");
    }
    const manifestPath = join(revisionRoot, "manifest.json");
    const manifest = {
      schema: 2,
      revision_id: revisionId,
      run_id: runId,
      label: "rework",
      source_state: join(revisionRoot, "state.json"),
      created_at: new Date().toISOString(),
      state_sha256: createHash("sha256").update(lifecycleContentBytes(stateContent)).digest("hex"),
      artifact_sha256: artifactSha256,
    };
    after[manifestPath] = `${JSON.stringify(manifest, null, 2)}\n`;
    const nextSelections = options.context
      ? {
          ...Object.fromEntries(Object.entries(control.selections).map(([sessionId, selection]) => [sessionId, sessionId === options.context!.session_id ? { ...selection, active: false } : selection])),
          [options.context.session_id]: { run_id: runId, branch: current.branch, selected_at: new Date().toISOString(), active: true },
        }
      : Object.fromEntries(Object.entries(control.selections).map(([sessionId, selection]) => [sessionId, selection.run_id === runId ? { ...selection, active: true } : selection]));
    const nextCandidate = candidateForState(nextState);
    const nextReceipt = {
      ...transitionReceiptForSnapshots(receipt, candidateForState(current), nextCandidate),
      payload_hash: requestHash,
    };
    const nextControl: RunControl = { ...control, revision: control.revision + 1, runs: { ...control.runs, [runId]: nextCandidate }, selections: nextSelections, ...(options.context ? { execution_claim: publishedClaim } : {}) };
    const nextControlWithReceipt = { ...nextControl, prepare_receipts: { ...nextControl.prepare_receipts, [request.request_id]: nextReceipt } };
    assertReceiptBinding(cwd, nextControlWithReceipt, request.request_id, nextReceipt, false);
    after[controlPathValue] = `${JSON.stringify(nextControlWithReceipt, null, 2)}\n`;
    const before: Record<string, LifecycleFileContent> = { [statePath]: stateRaw, [controlPathValue]: controlBefore };
    for (const path of ownedFiles) {
      before[path] = readLifecycleFileContent(path);
      after[path] = null;
    }
    const tx = beginLifecycleTransaction({ cwd, operation: "rework", before, after });
    commitLifecycleTransaction(cwd, tx.transaction_id);
    Object.assign(receipt, nextReceipt);
    return nextState;
  });
}


export function deactivateSessionSelection(cwd: string, sessionId: string): void {
  if (!sessionId) return;
  withWorkspaceTransaction(cwd, () => {
    const before = controlContent(cwd);
    const control = readControlRaw(cwd);
    const selection = control.selections[sessionId];
    if (!selection || !selection.active) return;
    writeControlTransaction(cwd, before, { ...control, revision: control.revision + 1, selections: { ...control.selections, [sessionId]: { ...selection, active: false } } }, "claim");
  });
}

export function selectSession(cwd: string, context: TrustedExecutionContext, runId: string, branch: string, active = true): void {
  ensureRunId(runId);
  withWorkspaceTransaction(cwd, () => {
    const before = controlContent(cwd);
    const control = readControlRaw(cwd);
    writeControlTransaction(cwd, before, {
      ...control,
      revision: control.revision + 1,
      selections: {
        ...Object.fromEntries(Object.entries(control.selections).map(([sessionId, selection]) => [sessionId, sessionId === context.session_id ? { ...selection, active: false } : selection])),
        [context.session_id]: { run_id: runId, branch, selected_at: new Date().toISOString(), active },
      },
    }, "claim");
  });
}

export function sessionSelection(cwd: string, sessionId: string): { run_id: string; branch: string; selected_at: string; active: boolean } | null {
  return withWorkspaceRead(cwd, () => readControlRaw(cwd).selections[sessionId] ?? null, () => null);
}

function readLifecycleFileContent(path: string): LifecycleFileContent {
  try {
    const bytes = readFileSync(path);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      try { return "\ufeff" + new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3)); }
      catch { return { encoding: "base64", data: bytes.toString("base64") }; }
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return { encoding: "base64", data: bytes.toString("base64") }; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function lifecycleContentBytes(content: LifecycleFileContent): Buffer {
  if (content === null) throw new LifecycleError("run_state_invalid", "snapshot content unexpectedly missing");
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content.data, "base64");
}

function collectSnapshotFiles(root: string, overrides: Record<string, LifecycleFileContent> = {}): Record<string, LifecycleFileContent> {
  const files: Record<string, LifecycleFileContent> = {};
  const visit = (directory: string, prefix: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path, key);
      else if (entry.isFile()) {
        const override = overrides[key];
        if (override !== undefined) {
          files[key] = override;
          continue;
        }
        const bytes = readFileSync(path);
        try { files[key] = { encoding: "base64", data: bytes.toString("base64") }; }
        catch { throw new LifecycleError("run_state_invalid", `snapshot source cannot encode file '${path}'`); }
      }
      else throw new LifecycleError("run_state_invalid", `snapshot source contains a non-regular entry '${path}'`);
    }
  };
  visit(root, "");
  return files;
}

export function snapshotCanonicalRun(cwd: string, runId: string, label = "rework"): { revision_id: string; manifest_path: string } {
  ensureRunId(runId);
  return withWorkspaceTransaction(cwd, () => {
    const statePath = runStatePath(cwd, runId);
    if (!existsSync(statePath)) throw new LifecycleError("run_not_found", `run '${runId}' is missing`, { run_id: runId });
    const source = join(resolve(cwd, WORK_STATE, RUNS_DIR, runId));
    const revisionId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID()}`;
    const destination = join(source, "revisions", revisionId);
    const sourceFiles = collectSnapshotFiles(source);
    const after: Record<string, LifecycleFileContent> = {};
    const artifactSha256: Record<string, string> = {};
    for (const [relativePath, content] of Object.entries(sourceFiles)) {
      if (relativePath.startsWith(`revisions/`)) continue;
      const target = join(destination, relativePath);
      after[target] = content;
      if (relativePath.startsWith("artifacts/")) artifactSha256[relativePath.slice("artifacts/".length)] = createHash("sha256").update(lifecycleContentBytes(content)).digest("hex");
    }
    const stateContent = sourceFiles["state.json"];
    if (stateContent === undefined) throw new LifecycleError("run_state_invalid", `run '${runId}' has no state.json`, { run_id: runId });
    const manifestPath = join(destination, "manifest.json");
    const manifest = {
      schema: 2,
      revision_id: revisionId,
      run_id: runId,
      label,
      source_state: join(destination, "state.json"),
      created_at: new Date().toISOString(),
      state_sha256: createHash("sha256").update(lifecycleContentBytes(stateContent)).digest("hex"),
      artifact_sha256: artifactSha256,
    };
    after[manifestPath] = `${JSON.stringify(manifest, null, 2)}\n`;
    const before: Record<string, LifecycleFileContent> = Object.fromEntries(Object.keys(after).map((path) => [path, null]));
    const transaction = beginLifecycleTransaction({ cwd, operation: "rework", before, after });
    commitLifecycleTransaction(cwd, transaction.transaction_id);
    return { revision_id: revisionId, manifest_path: manifestPath };
  });
}

/** Build the control sidecar publication for a terminal state transition. */
export function terminalControlPublication(cwd: string, previous: TeamState | null, next: TeamState): StatePublication | undefined {
  if (!previous || next.pause.kind !== "done" || !next.run_id) return undefined;
  const controlBefore = controlContent(cwd);
  const control = readControlRaw(cwd);
  const claim = control.execution_claim;
  if (claim && claim.run_id !== next.run_id) throw new LifecycleError("run_busy", `worktree execution is owned by run ${claim.run_id}`, { run_id: claim.run_id });
  const nextControl: RunControl = {
    ...control,
    revision: control.revision + 1,
    execution_claim: claim ? null : control.execution_claim,
    runs: { ...control.runs, [next.run_id]: candidateForState(next) },
    selections: Object.fromEntries(Object.entries(control.selections).map(([sessionId, selection]) => [sessionId, selection.run_id === next.run_id ? { ...selection, active: false } : selection])),
  };
  return {
    operation: "resume",
    before: { [controlPath(cwd)]: controlBefore },
    after: { [controlPath(cwd)]: `${JSON.stringify(nextControl, null, 2)}\n` },
  };
}

/**
 * Publish terminal state, run-control claim release, and session-selection
 * demotion through one lifecycle journal transaction. The ownership token is
 * checked again while the workspace lock is held; a missing token is valid
 * only when no claim exists for this run.
 */
export function finalizeCanonicalRun(cwd: string, runId: string, ownershipToken?: string): TeamState {
  ensureRunId(runId);
  return withWorkspaceTransaction(cwd, () => {
    const target = runTarget(cwd, runId);
    const statePath = target.statePath!;
    if (!existsSync(statePath)) throw new LifecycleError("run_not_found", `run ${runId} is missing`, { run_id: runId });
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(statePath, "utf8"));
    } catch (error) {
      throw new LifecycleError("recovery_required", `run ${runId} state is unreadable: ${(error as Error).message}`, { run_id: runId });
    }
    const issues: string[] = [];
    const state = normalizePersistedState(parsed, issues);
    if (!state || state.schema !== 2 || state.run_id !== runId || state.run_key !== runId) {
      throw new LifecycleError("run_state_invalid", `run ${runId} state is invalid: ${issues.join("; ")}`, { run_id: runId });
    }
    const resumablePause = state.pause.kind === "user_checkpoint" || state.pause.kind === "needs_human" || state.pause.kind === "background_wait" || state.pause.kind === "failed";
    if (resumablePause) return state;
    const done = state.stages.every((stage) => stage.status === "done" || stage.status === "skipped");
    const nextState: TeamState = {
      ...state,
      lifecycle_status: done ? "complete" : "failed",
      pause: { kind: done ? "done" : "failed", reason: done ? "" : "one or more stages failed" },
      state_revision: (typeof state.state_revision === "number" ? state.state_revision : 0) + 1,
      updated_at: new Date().toISOString(),
    };
    const beforeControl = controlContent(cwd);
    const control = readControlRaw(cwd);
    const claim = control.execution_claim;
    if (claim && claim.run_id !== runId) throw new LifecycleError("run_busy", `worktree execution is owned by run ${claim.run_id}`, { run_id: claim.run_id });
    if (claim && (!ownershipToken || claim.token !== ownershipToken)) throw new LifecycleError("run_busy", "terminal publication requires the current trusted ownership token", { run_id: runId });
    const nextControl: RunControl = {
      ...control,
      revision: control.revision + 1,
      execution_claim: claim ? null : control.execution_claim,
      runs: { ...control.runs, [runId]: candidateForState(nextState) },
      selections: Object.fromEntries(Object.entries(control.selections).map(([sessionId, selection]) => [sessionId, selection.run_id === runId ? { ...selection, active: false } : selection])),
    };
    const transaction = beginLifecycleTransaction({
      cwd,
      operation: "resume",
      before: { [statePath]: readFileSync(statePath, "utf8"), [controlPath(cwd)]: beforeControl },
      after: { [statePath]: `${JSON.stringify(nextState, null, 2)}\n`, [controlPath(cwd)]: `${JSON.stringify(nextControl, null, 2)}\n` },
    });
    commitLifecycleTransaction(cwd, transaction.transaction_id);
    return nextState;
  });
}

export function lifecycleTransactionPath(cwd: string, transactionId = randomUUID()): string {
  return transactionDir(cwd, transactionId);
}

export const ordinaryRunIdentity = (state: TeamState): OrdinaryRunIdentity => ({ schema: 2, run_id: state.run_id ?? "", run_key: state.run_key ?? "", branch: state.branch });
export function resumeCanonicalRun(
  cwd: string,
  runId: string,
  context: TrustedExecutionContext,
  options: { request: LifecycleRequest; receipt: PrepareRequestReceipt },
): TeamState {
  if (options.request.mode !== "resume" || options.receipt.operation !== "resume" || options.request.run_id !== runId || options.receipt.request_id !== options.request.request_id) {
    throw new LifecycleError("lifecycle_request_conflict", "resumeCanonicalRun requires a matching resume request and receipt", { run_id: runId });
  }
  return withWorkspaceTransaction(cwd, () => {
    const target = runTarget(cwd, runId);
    const statePath = target.statePath!;
    if (!existsSync(statePath)) throw new LifecycleError("run_not_found", `run '${runId}' is missing`, { run_id: runId });
    const stateRaw = readFileSync(statePath, "utf8");
    const controlPathValue = controlPath(cwd);
    const controlBefore = controlContent(cwd);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stateRaw);
    } catch (error) {
      throw new LifecycleError("recovery_required", `run '${runId}' state is unreadable: ${(error as Error).message}`, { run_id: runId });
    }
    const issues: string[] = [];
    const current = normalizePersistedState(parsed, issues);
    if (!current || current.schema !== 2 || current.run_id !== runId || current.run_key !== runId) {
      throw new LifecycleError("run_state_invalid", `run '${runId}' state is invalid: ${issues.join("; ") || "canonical identity is invalid"}`, { run_id: runId });
    }
    if (context.branch !== current.branch) throw new LifecycleError("run_context_mismatch", `run '${runId}' belongs to branch '${current.branch}'`, { run_id: runId, branch: current.branch });
    const control = readControlRaw(cwd);
    const requestHash = options.request ? lifecyclePayloadHash(options.request) : null;
    const existing = options.request ? control.prepare_receipts[options.request.request_id] : undefined;
    if (existing) {
      if (existing.payload_hash !== requestHash) {
        throw new LifecycleError("lifecycle_request_conflict", "request_id replayed with a different payload", { run_id: existing.selected_run_id });
      }
      if (options.receipt) Object.assign(options.receipt, existing);
      const replayTarget = runTarget(cwd, existing.selected_run_id);
      if (!existsSync(replayTarget.statePath!)) throw new LifecycleError("recovery_required", "exact replay receipt points to a missing canonical run", { run_id: existing.selected_run_id });
      let replayParsed: unknown;
      try {
        replayParsed = JSON.parse(readFileSync(replayTarget.statePath!, "utf8"));
      } catch (error) {
        throw new LifecycleError("recovery_required", `exact replay state is unreadable: ${(error as Error).message}`, { run_id: existing.selected_run_id });
      }
      const replayIssues: string[] = [];
      const replayState = normalizePersistedState(replayParsed, replayIssues);
      if (!replayState || replayState.schema !== 2 || replayState.run_id !== existing.selected_run_id || replayState.run_key !== existing.selected_run_id) {
        throw new LifecycleError("recovery_required", `exact replay state is invalid: ${replayIssues.join("; ")}`, { run_id: existing.selected_run_id });
      }
      return replayState;
    }
    if (current.lifecycle_status === "complete" || current.pause.kind === "done") throw new LifecycleError("run_terminal", `run '${runId}' is complete; use rework or new`, { run_id: runId });

    const currentClaim = control.execution_claim;
    let publishedClaim: WorktreeExecutionClaim;
    if (currentClaim?.run_id === runId) {
      if (!currentClaim.released_at && claimBusy(currentClaim, context)) {
        throw new LifecycleError("run_busy", `coordinator for run '${runId}' is still live`, { run_id: runId, next_action: "wait for a release receipt or reconcile the owner" });
      }
      publishedClaim = {
        ...currentClaim,
        token: randomUUID(),
        coordinator_session_id: context.session_id,
        ...(context.process_id ? { coordinator_process_id: context.process_id } : {}),
        ownership_epoch: randomUUID(),
        released_at: null,
      };
    } else if (!currentClaim) {
      publishedClaim = {
        token: randomUUID(),
        owner_kind: "workflow",
        run_id: runId,
        coordinator_session_id: context.session_id,
        ...(context.process_id ? { coordinator_process_id: context.process_id } : {}),
        ownership_epoch: randomUUID(),
        worker_ids: [],
        released_at: null,
      };
    } else {
      throw new LifecycleError("run_busy", `worktree execution is owned by run '${currentClaim.run_id}'`, { run_id: currentClaim.run_id });
    }

    const capabilityPending = current.dispatch_capability?.pending?.some((entry) =>
      entry.status === "authorized" || entry.status === "running" || entry.status === "pending",
    ) ?? false;
    let nextState: TeamState;
    if (!current.pending && !capabilityPending) {
      nextState = { ...current, lifecycle_status: current.pause.kind === "none" ? "active" : "paused" };
    } else {
      nextState = {
        ...current,
        lifecycle_status: "paused",
        pause: { kind: "background_wait", reason: "transport_reconnect: persisted dispatch awaits a verifiable provider receipt" },
      };
      if (current.pending) {
        nextState.pending = { ...current.pending, status: "pending", pending_reason: "transport_reconnect", updated_at: new Date().toISOString() };
      } else {
        delete nextState.pending;
      }
    }
    nextState = {
      ...nextState,
      state_revision: (typeof current.state_revision === "number" ? current.state_revision : 0) + 1,
      updated_at: new Date().toISOString(),
    };
    const previousCandidate = candidateForState(current);
    const selectedCandidate = candidateForState(nextState);
    const nextReceipt = options.request && options.receipt
      ? {
          ...transitionReceiptForSnapshots(options.receipt, previousCandidate, selectedCandidate),
          payload_hash: requestHash!,
        }
      : null;
    const nextSelections = {
      ...Object.fromEntries(Object.entries(control.selections).map(([sessionId, selection]) => [sessionId, sessionId === context.session_id ? { ...selection, active: false } : selection])),
      [context.session_id]: { run_id: runId, branch: current.branch, selected_at: new Date().toISOString(), active: true },
    };
    const nextControl: RunControl = {
      ...control,
      revision: control.revision + 1,
      execution_claim: publishedClaim,
      runs: { ...control.runs, [runId]: selectedCandidate },
      selections: nextSelections,
      ...(nextReceipt ? { prepare_receipts: { ...control.prepare_receipts, [options.request!.request_id]: nextReceipt } } : {}),
    };
    if (nextReceipt) assertReceiptBinding(cwd, nextControl, options.request!.request_id, nextReceipt, false);
    const transaction = beginLifecycleTransaction({
      cwd,
      operation: "resume",
      before: { [statePath]: stateRaw, [controlPathValue]: controlBefore },
      after: { [statePath]: `${JSON.stringify(nextState, null, 2)}\n`, [controlPathValue]: `${JSON.stringify(nextControl, null, 2)}\n` },
    });
    commitLifecycleTransaction(cwd, transaction.transaction_id);
    if (nextReceipt && options.receipt) Object.assign(options.receipt, nextReceipt);
    return nextState;
  });
}
