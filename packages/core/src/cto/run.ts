/**
 * CTO lifecycle adapter.
 *
 * The generic engine owns worktree claims and the lifecycle journal; this
 * domain adapter owns only CtoState construction, terminality and the
 * authenticated host-session seam.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildTeamPlan, validateDecompositionDepth, type PlanTeamInput } from "./plan.js";
import {
  ctoStatePath,
  ctoStateSnapshot,
  isCtoRunTerminal,
  newCtoState,
  readCtoState,
  parseCtoState,
  validateCtoStateCandidate,
  bindCtoTerminalTransition,
  registerCtoTerminalTransitionHook,
  type CtoTerminalTransitionProof,
} from "./state.js";
import { evaluateNativeStageReadiness } from "./native-stage.js";
import { LifecycleError, assertTrustedExecutionContext } from "../engine/run-lifecycle.js";
import {
  beginLifecycleTransaction,
  commitLifecycleTransaction,
  lifecycleTransactionStatus,
  type LifecycleFileContent,
} from "../engine/lifecycle-journal.js";
import { withWorkspaceReadNoRecovery, withWorkspaceTransaction } from "../engine/state.js";
import type { ModelClassification } from "../engine/run.js";
import {
  bindCtoClaim,
  clearCtoClaim,
  ctoClaimCredentials,
  type WorkflowSessionController,
} from "../engine/host-controller.js";
import {
  publishCtoClaim,
  readRunControl,
  readRunControlNoRecovery,
  releaseExecutionClaim,
  controlPath,
  type ClaimResult,
  type CtoClaimPublication,
} from "../engine/run-store.js";
import { isRecord } from "../engine/control-plane-contract.js";
import { validateTypedControlPlane } from "../engine/workflow-contract.js";
import type { CtoReleaseProvenance, CtoClaimScope, RunControl, TrustedExecutionContext, WorktreeExecutionClaim, WorkIdentity } from "../engine/types.js";
import type { CtoState, TeamDef, TeamPlan } from "./types.js";

export interface RunCtoOptions {
  task: string;
  cwd: string;
  branch: string;
  autonomous: boolean;
  classification?: ModelClassification;
  teams: PlanTeamInput[];
  defs: Record<string, TeamDef> | Map<string, TeamDef>;
  profileDepth?: (profile: string) => number;
  standby?: boolean;
  owner_session?: string;
  execution: TrustedExecutionContext;
  log?: (line: string) => void;
}

export type RunCtoResult =
  | { ok: true; plan: TeamPlan; state: CtoState; statePath: string }
  | { ok: false; reason: string };

export interface CtoIngressOptions {
  cwd: string;
  branch: string;
  task: string;
  run_id?: string;
  controller: WorkflowSessionController;
}

export interface CtoRecoveryResult {
  recovery_id: string;
  source_sha256: string;
  raw_backup_path: string;
  receipt_path: string;
}

export interface CtoIngressResult {
  run_id: string;
  state: CtoState;
  claim: ClaimResult;
  statePath: string;
  created: boolean;
  standby: boolean;
  recovery?: CtoRecoveryResult;
}
export interface CtoModelStateReadResult {
  state: CtoState;
  state_revision: string;
}

export interface CtoModelStateCommitResult extends CtoModelStateReadResult {
  transition: "state" | "terminal";
}

type CtoModelAuthority = {
  context: TrustedExecutionContext;
  token: string;
  ownership_epoch: string;
};
type CtoTerminalRecoveryRecord = {
  transaction_id: string;
  controller: WorkflowSessionController;
  cwd: string;
  run_id: string;
  token: string;
  ownership_epoch: string;
  coordinator_session_id: string;
  coordinator_process_id?: number;
  branch: string;
  after_state: string;
  after_control: string;
};

const ctoControllersByClaim = new Map<string, WorkflowSessionController>();
const pendingCtoTerminalRecoveries = new Map<string, CtoTerminalRecoveryRecord>();

function ctoClaimBindingKey(cwd: string, claim: { run_id: string; token: string; ownership_epoch: string }): string {
  return `${resolve(cwd)}\u0000${claim.run_id}\u0000${claim.token}\u0000${claim.ownership_epoch}`;
}

function rememberCtoController(controller: WorkflowSessionController, cwd: string, claim: { run_id: string; token: string; ownership_epoch: string }): void {
  ctoControllersByClaim.set(ctoClaimBindingKey(cwd, claim), controller);
}

function clearCtoClaimIfCurrent(controller: WorkflowSessionController, claim: { run_id: string; token: string; ownership_epoch: string }): void {
  const current = ctoClaimCredentials(controller);
  if (
    current?.run_id === claim.run_id
    && current.token === claim.token
    && current.ownership_epoch === claim.ownership_epoch
  ) {
    clearCtoClaim(controller);
    ctoControllersByClaim.delete(ctoClaimBindingKey(controller.context().worktree, claim));
  }
}

function transactionKey(cwd: string, path: string): string {
  return relative(resolve(cwd), resolve(path)).split("\\").join("/");
}

function parseRunControlImage(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const decoded: unknown = JSON.parse(raw);
    return isRecord(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function sameCtoReleaseIssuance(value: unknown, expected: CtoReleaseProvenance): boolean {
  if (!isRecord(value)) return false;
  return value.schema === expected.schema
    && value.run_id === expected.run_id
    && value.branch === expected.branch
    && value.ownership_epoch === expected.ownership_epoch
    && value.coordinator_session_id === expected.coordinator_session_id
    && (value.coordinator_process_id ?? undefined) === (expected.coordinator_process_id ?? undefined)
    && sameStringArray(value.worker_ids, expected.worker_ids)
    && sameStringArray(value.pending_worker_ids, expected.pending_worker_ids)
    && value.ledger_revision === expected.ledger_revision
    && value.issuance_token === expected.issuance_token
    && value.released_at === expected.released_at
    && value.reason === expected.reason
    && value.release_receipt === expected.release_receipt
    && value.snapshot_hash === expected.snapshot_hash;
}

function recoveryClaimMatches(
  value: unknown,
  record: CtoTerminalRecoveryRecord,
): value is WorktreeExecutionClaim {
  if (!isRecord(value)) return false;
  return value.owner_kind === "cto"
    && value.run_id === record.run_id
    && value.token === record.token
    && value.ownership_epoch === record.ownership_epoch
    && value.coordinator_session_id === record.coordinator_session_id
    && (value.coordinator_process_id ?? undefined) === (record.coordinator_process_id ?? undefined)
    && value.released_at === null
    && Array.isArray(value.worker_ids)
    && value.worker_ids.every((workerId) => typeof workerId === "string");
}

function reconcileCtoTerminalRecovery(controller: WorkflowSessionController, cwd: string): void {
  const records = [...pendingCtoTerminalRecoveries.values()].filter((record) =>
    record.controller === controller && resolve(record.cwd) === resolve(cwd),
  );
  if (records.length === 0) return;
  // This is a trusted recovery boundary. It may repair a committed journal
  // forward, but it never mutates a binding based on a stale getter result.
  readRunControl(cwd);
  for (const record of records) {
    const journal = lifecycleTransactionStatus(cwd, record.transaction_id);
    if (!journal) continue;
    if (journal.status === "rolled_back") {
      pendingCtoTerminalRecoveries.delete(record.transaction_id);
      continue;
    }
    if (journal.status !== "committed" || journal.commit_marker === null) continue;
    const stateAfter = journal.after[transactionKey(cwd, ctoStatePath(record.run_id, cwd))];
    const controlAfter = journal.after[transactionKey(cwd, controlPath(cwd))];
    if (stateAfter !== record.after_state || controlAfter !== record.after_control || typeof stateAfter !== "string" || typeof controlAfter !== "string") continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(stateAfter);
    } catch {
      continue;
    }
    const parsed = parseCtoState(decoded, record.run_id);
    if (!parsed.ok || !isCtoRunTerminal(parsed.state)) continue;
    let control: RunControl;
    let controlRaw: string;
    let stateRaw: string;
    try {
      control = readRunControlNoRecovery(cwd);
      controlRaw = readFileSync(controlPath(cwd), "utf8");
      stateRaw = readFileSync(ctoStatePath(record.run_id, cwd), "utf8");
    } catch {
      continue;
    }
    if (controlRaw !== record.after_control || stateRaw !== record.after_state) continue;
    const afterControl = parseRunControlImage(controlAfter);
    const beforeControl = parseRunControlImage(journal.before[transactionKey(cwd, controlPath(cwd))]);
    const beforeClaim = beforeControl?.execution_claim;
    const beforeReleases = beforeControl?.cto_releases;
    const beforeRevision = beforeControl?.revision;
    const afterRevision = afterControl?.revision;
    const release = control.cto_releases[record.run_id];
    if (
      !afterControl
      || afterControl.schema !== 2
      || afterControl.execution_claim !== null
      || !beforeControl
      || beforeControl.schema !== 2
      || typeof beforeRevision !== "number"
      || !Number.isInteger(beforeRevision)
      || typeof afterRevision !== "number"
      || !Number.isInteger(afterRevision)
      || afterRevision !== beforeRevision + 1
      || !isRecord(beforeReleases)
      || !recoveryClaimMatches(beforeClaim, record)
      || control.execution_claim !== null
      || !release
      || release.current_snapshot_hash !== ctoStateRevision(stateAfter)
      || !sameStringArray(beforeClaim.worker_ids, release.pending_worker_ids)
    ) continue;
    const priorRelease = beforeReleases[record.run_id];
    if (priorRelease === undefined) {
      if (
        release.issuance_token !== record.token
        || release.ownership_epoch !== record.ownership_epoch
        || release.coordinator_session_id !== record.coordinator_session_id
        || (release.coordinator_process_id ?? undefined) !== (record.coordinator_process_id ?? undefined)
        || release.branch !== record.branch
      ) continue;
    } else if (
      !sameCtoReleaseIssuance(priorRelease, release)
      || beforeClaim.release_receipt !== release.release_receipt
    ) continue;
    const current = ctoClaimCredentials(record.controller);
    if (
      !current
      || current.run_id !== record.run_id
      || current.token !== record.token
      || current.ownership_epoch !== record.ownership_epoch
    ) continue;
    clearCtoClaimIfCurrent(record.controller, record);
    pendingCtoTerminalRecoveries.delete(record.transaction_id);
  }
}

function ctoStateRevision(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

const MODEL_IMMUTABLE_CTO_FIELDS = ["native_stage_progress", "stage_receipts", "stage_recovery"] as const;

function canonicalModelValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalModelValue(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalModelValue(entry)]));
}

function assertModelCannotMutateEngineOwnedCtoFields(current: CtoState, candidate: CtoState, runId: string): void {
  const currentRecord = current as unknown as Record<string, unknown>;
  const candidateRecord = candidate as unknown as Record<string, unknown>;
  for (const field of MODEL_IMMUTABLE_CTO_FIELDS) {
    if (JSON.stringify(canonicalModelValue(currentRecord[field])) !== JSON.stringify(canonicalModelValue(candidateRecord[field]))) {
      throw new LifecycleError("run_state_invalid", `cto_state candidate attempted to mutate engine-owned field '${field}'`, { run_id: runId });
    }
  }
}

function captureCtoModelAuthority(
  controller: WorkflowSessionController,
  cwd: string,
  runId: string,
): CtoModelAuthority {
  reconcileCtoTerminalRecovery(controller, cwd);
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..") {
    throw new LifecycleError("lifecycle_request_conflict", `invalid exact CTO run id '${runId}'`, { run_id: runId });
  }
  const context = controller.context();
  assertTrustedExecutionContext(context);
  if (
    context.caller !== "host"
    || context.authority !== "coordinator"
    || resolve(context.worktree) !== resolve(cwd)
  ) {
    throw new LifecycleError("lifecycle_request_conflict", "cto_state requires the authenticated interactive coordinator", { run_id: runId });
  }
  const credentials = ctoClaimCredentials(controller);
  if (!credentials || credentials.run_id !== runId) {
    throw new LifecycleError("run_busy", "cto_state requires the exact private coordinator binding", { run_id: runId });
  }
  const scope = controller.activeCtoClaim();
  if (
    !scope
    || scope.run_id !== credentials.run_id
    || scope.ownership_epoch !== credentials.ownership_epoch
  ) {
    throw new LifecycleError("run_busy", "cto_state coordinator binding is stale", { run_id: runId });
  }
  return { context, token: credentials.token, ownership_epoch: credentials.ownership_epoch };
}

function assertCurrentCtoModelClaim(
  control: RunControl,
  authority: CtoModelAuthority,
  runId: string,
): WorktreeExecutionClaim {
  const claim = control.execution_claim;
  if (
    !claim
    || claim.owner_kind !== "cto"
    || claim.run_id !== runId
    || claim.token !== authority.token
    || claim.ownership_epoch !== authority.ownership_epoch
    || claim.coordinator_session_id !== authority.context.session_id
    || (claim.coordinator_process_id ?? undefined) !== (authority.context.process_id ?? undefined)
    || claim.released_at !== null
  ) {
    throw new LifecycleError("run_busy", "cto_state coordinator claim is no longer current", { run_id: runId, next_action: "reacquire the exact CTO run" });
  }
  return claim;
}

/**
 * Registered model read ingress. The revision is a state-byte fingerprint,
 * not a credential; commit captures the private binding again under lock.
 */
export function readCtoStateForModel(
  controller: WorkflowSessionController,
  cwd: string,
  runId: string,
): CtoModelStateReadResult {
  const authority = captureCtoModelAuthority(controller, cwd, runId);
  return withWorkspaceReadNoRecovery(
    cwd,
    () => {
      const control = readRunControlNoRecovery(cwd);
      assertCurrentCtoModelClaim(control, authority, runId);
      let raw: string;
      try {
        raw = readFileSync(ctoStatePath(runId, cwd), "utf8");
      } catch {
        throw new LifecycleError("run_not_found", `CTO run '${runId}' is missing`, { run_id: runId });
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw new LifecycleError("recovery_required", `CTO run '${runId}' state is not valid JSON`, { run_id: runId, next_action: "repair the canonical CTO state before continuing" });
      }
      const parsed = parseCtoState(decoded, runId);
      if (!parsed.ok) {
        throw new LifecycleError("recovery_required", `CTO run '${runId}' state is invalid: ${parsed.error}`, { run_id: runId, next_action: "repair the canonical CTO state before continuing" });
      }
      if (parsed.state.branch !== authority.context.branch) {
        throw new LifecycleError("run_context_mismatch", `CTO run '${runId}' belongs to branch '${parsed.state.branch}'`, { run_id: runId, branch: parsed.state.branch });
      }
      return { state: parsed.state, state_revision: ctoStateRevision(raw) };
    },
    () => {
      throw new LifecycleError("run_not_found", `CTO run '${runId}' is missing`, { run_id: runId });
    },
  );
}

/**
 * Registered model commit ingress. State publication and terminal claim
 * release are prepared in one recoverable lifecycle journal transaction.
 */
export function commitCtoStateForModel(input: {
  controller: WorkflowSessionController;
  cwd: string;
  run_id: string;
  expected_state_revision: string;
  state: unknown;
}): CtoModelStateCommitResult {
  const authority = captureCtoModelAuthority(input.controller, input.cwd, input.run_id);
  if (!input.expected_state_revision) {
    throw new LifecycleError("lifecycle_request_conflict", "cto_state commit requires the exact revision returned by read", { run_id: input.run_id });
  }
  let candidate: CtoState;
  try {
    candidate = validateCtoStateCandidate(input.state, input.run_id);
  } catch (error) {
    throw new LifecycleError("run_state_invalid", `CTO state candidate is invalid: ${(error as Error).message}`, { run_id: input.run_id });
  }
  return withWorkspaceTransaction(input.cwd, () => {
    const control = readRunControlNoRecovery(input.cwd);
    const claim = assertCurrentCtoModelClaim(control, authority, input.run_id);
    const statePath = ctoStatePath(input.run_id, input.cwd);
    let beforeState: string;
    try {
      beforeState = readFileSync(statePath, "utf8");
    } catch {
      throw new LifecycleError("run_not_found", `CTO run '${input.run_id}' is missing`, { run_id: input.run_id });
    }
    if (ctoStateRevision(beforeState) !== input.expected_state_revision) {
      throw new LifecycleError("lifecycle_request_conflict", "cto_state commit revision is stale; reread the exact run before committing", {
        run_id: input.run_id,
        next_action: "call cto_state read again and commit with its returned state_revision",
      });
    }
    let currentDecoded: unknown;
    try {
      currentDecoded = JSON.parse(beforeState);
    } catch {
      throw new LifecycleError("recovery_required", `CTO run '${input.run_id}' state is not valid JSON`, { run_id: input.run_id, next_action: "repair the canonical CTO state before continuing" });
    }
    const currentParsed = parseCtoState(currentDecoded, input.run_id);
    if (!currentParsed.ok) {
      throw new LifecycleError("recovery_required", `CTO run '${input.run_id}' state is invalid: ${currentParsed.error}`, { run_id: input.run_id, next_action: "repair the canonical CTO state before continuing" });
    }
    const currentTypedValidation = validateTypedControlPlane(currentDecoded);
    if (!currentTypedValidation.ok) {
      throw new LifecycleError(
        "recovery_required",
        `CTO run '${input.run_id}' typed control-plane state is invalid: ${currentTypedValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
        { run_id: input.run_id, next_action: "repair the canonical CTO state before continuing" },
      );
    }
    const current = currentParsed.state;
    assertModelCannotMutateEngineOwnedCtoFields(current, candidate, input.run_id);
    if (current.branch !== authority.context.branch || candidate.branch !== current.branch) {
      throw new LifecycleError("run_context_mismatch", `CTO run '${input.run_id}' branch does not match the authenticated coordinator`, { run_id: input.run_id, branch: current.branch });
    }
    if (candidate.owner_session !== current.owner_session || candidate.standby !== current.standby) {
      throw new LifecycleError("run_state_invalid", "cto_state candidate attempted to change engine-owned run identity", { run_id: input.run_id });
    }
    const terminal = isCtoRunTerminal(candidate);
    if (terminal && candidate.pause.kind !== "done" && current.native_stage_progress) {
      for (const [teamId, progress] of Object.entries(current.native_stage_progress)) {
        if (progress.status === "complete") continue;
        const readiness = evaluateNativeStageReadiness(input.cwd, input.run_id, teamId);
        if (!readiness.ok || !readiness.ready) {
          throw new LifecycleError("run_busy", `native stage '${progress.stage_id}' for team '${teamId}' is not ready for terminal CTO commit`, { run_id: input.run_id });
        }
      }
    }
    if (terminal && (
      claim.worker_ids.length > 0
      || hasOutstandingCtoWork(current) && !terminalBarrierSettlement(current, candidate)
      || hasOutstandingCtoWork(candidate)
    )) {
      throw new LifecycleError("run_busy", "terminal CTO state cannot bypass pending worker reservations or barriers", { run_id: input.run_id, next_action: "settle the pending CTO work before committing terminal state" });
    }
    const committedState: CtoState = {
      ...candidate,
      updated_at: new Date().toISOString(),
    };
    const stateContent = `${JSON.stringify(committedState, null, 2)}\n`;
    const nextStateRevision = ctoStateRevision(stateContent);
    let beforeControl: string;
    try {
      beforeControl = readFileSync(controlPath(input.cwd), "utf8");
    } catch {
      beforeControl = `${JSON.stringify(control, null, 2)}\n`;
    }
    let nextControl = control;
    if (terminal) {
      const existingRelease = control.cto_releases[input.run_id];
      let provenance: CtoReleaseProvenance;
      if (existingRelease) {
        if (existingRelease.issuance_token === claim.token) {
          throw new LifecycleError("recovery_required", "terminal CTO transition would overwrite its original issuance provenance", { run_id: input.run_id, next_action: "reconcile the existing CTO release before committing terminal state" });
        }
        if (
          existingRelease.pending_worker_ids.length !== claim.worker_ids.length
          || existingRelease.pending_worker_ids.some((workerId, index) => workerId !== claim.worker_ids[index])
        ) {
          throw new LifecycleError("recovery_required", "terminal CTO transition does not match the mutable reservation ledger", { run_id: input.run_id, next_action: "settle the pending CTO reservations before committing terminal state" });
        }
        provenance = {
          ...existingRelease,
          pending_worker_ids: [...claim.worker_ids],
          current_snapshot_hash: nextStateRevision,
        };
      } else {
        provenance = releaseProvenance(
          input.cwd,
          committedState,
          authority.context,
          "terminal",
          claim,
          nextStateRevision,
        );
      }
      nextControl = {
        ...control,
        revision: control.revision + 1,
        execution_claim: null,
        cto_releases: { ...control.cto_releases, [input.run_id]: provenance },
      };
    }
    const afterControl = terminal ? `${JSON.stringify(nextControl, null, 2)}\n` : beforeControl;
    const transaction = beginLifecycleTransaction({
      cwd: input.cwd,
      operation: "resume",
      before: { [statePath]: beforeState, [controlPath(input.cwd)]: beforeControl },
      after: {
        [statePath]: stateContent,
        [controlPath(input.cwd)]: afterControl,
      },
    });
    if (terminal) {
      rememberCtoController(input.controller, input.cwd, claim);
      pendingCtoTerminalRecoveries.set(transaction.transaction_id, {
        transaction_id: transaction.transaction_id,
        controller: input.controller,
        cwd: input.cwd,
        run_id: input.run_id,
        token: claim.token,
        ownership_epoch: claim.ownership_epoch,
        coordinator_session_id: claim.coordinator_session_id,
        ...(claim.coordinator_process_id === undefined ? {} : { coordinator_process_id: claim.coordinator_process_id }),
        branch: authority.context.branch,
        after_state: stateContent,
        after_control: afterControl,
      });
    }
    commitLifecycleTransaction(input.cwd, transaction.transaction_id);
    if (terminal) {
      pendingCtoTerminalRecoveries.delete(transaction.transaction_id);
      clearCtoClaimIfCurrent(input.controller, claim);
    }
    return {
      state: committedState,
      state_revision: nextStateRevision,
      transition: terminal ? "terminal" : "state",
    };
  });
}


let runSeq = 0;

/** Slug id: `<task-slug>-<timestamp-ms>-<seq>`, unique per run. */
export function ctoRunId(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 23).replace(/[:T.]/g, "-");
  runSeq += 1;
  return `${slug || "task"}-${stamp}-${runSeq.toString(36)}`;
}

function releaseSnapshotHash(cwd: string, runId: string): string {
  return createHash("sha256").update(readFileSync(ctoStatePath(runId, cwd), "utf8")).digest("hex");
}

function hasOutstandingCtoWork(state: CtoState): boolean {
  if (state.pending && ["authorized", "running", "pending", "transport_reconnect"].includes(state.pending.status)) return true;
  if (state.completion_envelope?.outcome === "pending") return true;
  if (state.child_join && ["planned", "authorized", "pending", "conflict"].includes(state.child_join.state)) return true;
  return state.child_joins?.some((join) => ["planned", "authorized", "pending", "conflict"].includes(join.state)) ?? false;
}

function sameWorkIdentity(left: WorkIdentity, right: WorkIdentity): boolean {
  return left.run_id === right.run_id
    && left.wave_id === right.wave_id
    && left.slice_id === right.slice_id
    && left.session_id === right.session_id
    && left.workflow === right.workflow
    && left.stage_id === right.stage_id
    && left.stage_cursor === right.stage_cursor
    && left.capability_id === right.capability_id
    && left.capability_epoch === right.capability_epoch
    && left.loop_iteration === right.loop_iteration
    && left.slot_id === right.slot_id
    && left.task_id === right.task_id
    && left.dispatch_id === right.dispatch_id
    && left.attempt === right.attempt
    && left.worker_id === right.worker_id;
}

function terminalBarrierSettlement(current: CtoState, candidate: CtoState): boolean {
  const activePending = ["authorized", "running", "pending", "transport_reconnect"];
  const activeJoins = ["planned", "authorized", "pending", "conflict"];
  if (current.pending && activePending.includes(current.pending.status)) {
    if (
      !candidate.pending
      || !sameWorkIdentity(current.pending.identity, candidate.pending.identity)
      || activePending.includes(candidate.pending.status)
    ) return false;
  }
  if (current.completion_envelope?.outcome === "pending") {
    if (
      !candidate.completion_envelope
      || !sameWorkIdentity(current.completion_envelope.identity, candidate.completion_envelope.identity)
      || candidate.completion_envelope.outcome === "pending"
    ) return false;
  }
  if (current.child_join && activeJoins.includes(current.child_join.state)) {
    if (
      !candidate.child_join
      || !sameWorkIdentity(current.child_join.parent, candidate.child_join.parent)
      || !sameWorkIdentity(current.child_join.child, candidate.child_join.child)
      || activeJoins.includes(candidate.child_join.state)
    ) return false;
  }
  for (const currentJoin of current.child_joins ?? []) {
    if (!activeJoins.includes(currentJoin.state)) continue;
    const candidateJoin = candidate.child_joins?.find((join) =>
      sameWorkIdentity(join.parent, currentJoin.parent)
      && sameWorkIdentity(join.child, currentJoin.child),
    );
    if (!candidateJoin || activeJoins.includes(candidateJoin.state)) return false;
  }
  return true;
}

function releaseReceipt(
  reason: CtoReleaseProvenance["reason"],
  claim: { token: string },
  state: CtoState,
  context: TrustedExecutionContext,
  ownership: { ownership_epoch: string; worker_ids: string[] },
  snapshotHash: string,
): string {
  const binding = [
    claim.token,
    reason,
    state.id,
    state.branch,
    ownership.ownership_epoch,
    context.session_id,
    context.process_id ?? "",
    ownership.worker_ids.join("\u0000"),
    snapshotHash,
  ].join("\u0001");
  return `omp-cto-${reason}-${createHash("sha256").update(binding).digest("hex")}`;
}

function releaseProvenance(
  cwd: string,
  state: CtoState,
  context: TrustedExecutionContext,
  reason: CtoReleaseProvenance["reason"],
  claim: { token: string; ownership_epoch: string; worker_ids: string[] },
  snapshotHash = releaseSnapshotHash(cwd, state.id),
): CtoReleaseProvenance {
  return {
    schema: 2,
    run_id: state.id,
    branch: state.branch,
    ownership_epoch: claim.ownership_epoch,
    coordinator_session_id: context.session_id,
    ...(context.process_id ? { coordinator_process_id: context.process_id } : {}),
    worker_ids: [...claim.worker_ids],
    pending_worker_ids: [...claim.worker_ids],
    ledger_revision: 0,
    issuance_token: claim.token,
    released_at: new Date().toISOString(),
    reason,
    release_receipt: releaseReceipt(reason, claim, state, context, claim, snapshotHash),
    snapshot_hash: snapshotHash,
    current_snapshot_hash: snapshotHash,
  };
}

type CtoStateEvidence =
  | { kind: "absent" }
  | { kind: "valid"; state: CtoState }
  | { kind: "corrupt" }
  | { kind: "markdown-only" };

function ctoStateEvidence(cwd: string, runId: string): CtoStateEvidence {
  const dir = join(cwd, ".work-state", "cto", runId);
  if (!existsSync(dir)) return { kind: "absent" };
  const statePath = ctoStatePath(runId, cwd);
  if (existsSync(statePath)) {
    const state = readCtoState(runId, cwd);
    return state ? { kind: "valid", state } : { kind: "corrupt" };
  }
  try {
    const files = readdirSync(dir);
    if (files.some((file) => ["cto_discovery.md", "team-plan.md", "decisions.md", "summary.md", "integration_review.md"].includes(file))) {
      return { kind: "markdown-only" };
    }
  } catch {
    return { kind: "corrupt" };
  }
  return { kind: "absent" };
}

function activeLegacyCtoStateIds(cwd: string): string[] {
  const root = join(cwd, ".work-state", "cto");
  if (!existsSync(root)) return [];
  const ids: string[] = [];
  for (const id of readdirSync(root)) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new LifecycleError("recovery_required", `legacy CTO run entry '${id.slice(0, 80)}' has an unsafe id`, { next_action: "repair or explicitly reconcile the legacy CTO state directory" });
    }
    const evidence = ctoStateEvidence(cwd, id);
    if (evidence.kind === "corrupt" || evidence.kind === "markdown-only") {
      throw new LifecycleError("recovery_required", `legacy CTO run '${id}' is unreadable or markdown-only`, { run_id: id, next_action: "repair or explicitly reconcile the legacy CTO run" });
    }
    if (evidence.kind === "valid" && !isCtoRunTerminal(evidence.state)) ids.push(id);
  }
  return ids;
}

const LEGACY_CTO_METADATA_KEYS = ["session", "workflow", "orchestration_profile", "stage", "checkpoint", "progress"] as const;
const LEGACY_RECOVERY_ATTESTATION = "I attest that the previous coordinator AND all workers for this run have been stopped.";
const LEGACY_COMPLETION_RATIONALE = "Recovery metadata: the legacy completion-intent rationale was absent; no historical approval or checkpoint authorization is inferred.";

type LegacyCtoRecoverySnapshot = {
  context: TrustedExecutionContext;
  state_bytes: Buffer;
  state_file: LifecycleFileContent;
  control_file: LifecycleFileContent;
  state_content: string;
  state: CtoState;
  recovery_id: string;
  source_sha256: string;
  raw_backup_path: string;
  receipt_path: string;
  receipt_content: string;
  confirmed_at: string;
  summary: string;
};

function optionalRawFile(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function lifecycleContent(bytes: Buffer | null): LifecycleFileContent {
  return bytes === null ? null : { encoding: "base64", data: bytes.toString("base64") };
}

function sameLifecycleContent(left: LifecycleFileContent, right: LifecycleFileContent): boolean {
  if (left === null || right === null) return left === right;
  const leftBytes = typeof left === "string" ? Buffer.from(left, "utf8") : Buffer.from(left.data, "base64");
  const rightBytes = typeof right === "string" ? Buffer.from(right, "utf8") : Buffer.from(right.data, "base64");
  return leftBytes.equals(rightBytes);
}

function sameTrustedContext(left: TrustedExecutionContext, right: TrustedExecutionContext): boolean {
  return left.session_id === right.session_id
    && left.caller === right.caller
    && left.authority === right.authority
    && left.branch === right.branch
    && resolve(left.worktree) === resolve(right.worktree)
    && (left.process_id ?? undefined) === (right.process_id ?? undefined);
}

function legacyRecoveryArtifactPaths(cwd: string, runId: string, recoveryId: string): { backup: string; receipt: string } {
  const directory = join(".work-state", "cto", runId, "legacy-recovery", recoveryId);
  return {
    backup: join(directory, "raw-state.json"),
    receipt: join(directory, "receipt.json"),
  };
}

function legacyRecoveryFailure(runId: string, message: string, nextAction = "repair or explicitly reconcile the legacy CTO run"): LifecycleError {
  return new LifecycleError("recovery_required", message, { run_id: runId, next_action: nextAction });
}

function buildLegacyRecoverySnapshot(
  options: CtoIngressOptions,
  context: TrustedExecutionContext,
  stateBytes: Buffer,
  control: RunControl,
  confirmedAt: string,
): LegacyCtoRecoverySnapshot {
  const runId = options.run_id!;
  const sourceSha256 = createHash("sha256").update(stateBytes).digest("hex");
  const rawText = stateBytes.toString("utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawText);
  } catch (error) {
    throw legacyRecoveryFailure(runId, "legacy CTO state is not valid JSON: " + (error as Error).message);
  }
  if (!isRecord(decoded)) throw legacyRecoveryFailure(runId, "legacy CTO state must be a JSON object");
  if (decoded.id !== runId) {
    throw new LifecycleError("run_context_mismatch", "legacy CTO run identity does not match the requested run", { run_id: runId });
  }
  if (decoded.branch !== options.branch) {
    throw new LifecycleError("run_context_mismatch", "legacy CTO run belongs to a different branch", { run_id: runId, branch: typeof decoded.branch === "string" ? decoded.branch : undefined });
  }
  if (control.execution_claim !== null) {
    throw new LifecycleError("run_busy", "legacy CTO recovery refuses an existing worktree claim", { run_id: runId, next_action: "release or reconcile the existing claim before recovery" });
  }
  if (control.cto_releases[runId] !== undefined) {
    throw legacyRecoveryFailure(runId, "legacy CTO run already has managed release provenance", "resume the managed CTO release instead of legacy recovery");
  }
  for (const [releaseRunId, release] of Object.entries(control.cto_releases)) {
    if (releaseRunId !== runId && release.pending_worker_ids.length > 0) {
      throw new LifecycleError("run_busy", "legacy CTO recovery refuses pending worker reservations in the release ledger", { run_id: releaseRunId, next_action: "settle pending workers before recovery" });
    }
  }

  const candidate: Record<string, unknown> = { ...decoded };
  const repairs: string[] = [];
  const recognizedLegacyKeys: string[] = [];
  for (const key of LEGACY_CTO_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(decoded, key)) continue;
    if (key === "session" && typeof decoded[key] !== "string") {
      throw legacyRecoveryFailure(runId, "legacy session metadata has an invalid type");
    }
    recognizedLegacyKeys.push(key);
    delete candidate[key];
  }
  if (decoded.schema === undefined || decoded.schema === 1) {
    candidate.schema = 2;
    repairs.push("schema");
  }
  if (!Object.prototype.hasOwnProperty.call(decoded, "updated_at")) {
    candidate.updated_at = confirmedAt;
    repairs.push("updated_at");
  }
  if (Object.prototype.hasOwnProperty.call(decoded, "completion_intent")) {
    const completion = decoded.completion_intent;
    if (isRecord(completion) && !Object.prototype.hasOwnProperty.call(completion, "rationale")) {
      candidate.completion_intent = { ...completion, rationale: LEGACY_COMPLETION_RATIONALE };
      repairs.push("completion_intent.rationale");
    }
  }
  if (Object.prototype.hasOwnProperty.call(decoded, "owner_session") && typeof decoded.owner_session !== "string") {
    throw legacyRecoveryFailure(runId, "canonical owner_session metadata has an invalid type");
  }
  if (decoded.owner_session !== context.session_id) repairs.push("owner_session");
  candidate.owner_session = context.session_id;

  let state: CtoState;
  try {
    state = validateCtoStateCandidate(candidate, runId);
  } catch (error) {
    throw legacyRecoveryFailure(runId, "legacy CTO state contains malformed or unrecognized typed fields: " + (error as Error).message);
  }
  if (isCtoRunTerminal(state)) {
    throw new LifecycleError("run_terminal", "legacy CTO run is terminal", { run_id: runId });
  }
  if (state.leases !== undefined) {
    if (!isRecord(state.leases)) throw legacyRecoveryFailure(runId, "legacy CTO lease ledger has an unrecognized shape");
    if (Object.keys(state.leases).length > 0) {
      throw new LifecycleError("run_busy", "legacy CTO recovery refuses active or unknown team lease evidence", { run_id: runId, next_action: "settle every team lease before recovery" });
    }
  }
  if (hasOutstandingCtoWork(state)) {
    throw new LifecycleError("run_busy", "legacy CTO recovery refuses pending worker or completion work", { run_id: runId, next_action: "settle pending CTO work before recovery" });
  }
  const finalStateContent = JSON.stringify(state, null, 2) + "\n";
  const paths = legacyRecoveryArtifactPaths(options.cwd, runId, sourceSha256);
  const previousOwner = typeof decoded.owner_session === "string"
    ? decoded.owner_session
    : typeof decoded.session === "string" ? decoded.session : "(unowned legacy run)";
  const summary = [
    "Recover claimless legacy CTO run '" + runId + "'.",
    "Branch: " + context.branch + ".",
    "Previous coordinator: " + previousOwner + ".",
    "New coordinator: " + context.session_id + ".",
    LEGACY_RECOVERY_ATTESTATION,
    "The legacy state is repaired only for recognized metadata; task, checkpoint policy, completion intent, artifacts, budget, and history are preserved, while legacy strings never authorize a checkpoint.",
  ].join("\n");
  const receipt = {
    schema: 1,
    kind: "cto_legacy_recovery",
    recovery_id: sourceSha256,
    run_id: runId,
    branch: context.branch,
    previous_coordinator: previousOwner,
    new_coordinator: context.session_id,
    ...(context.process_id === undefined ? {} : { coordinator_process_id: context.process_id }),
    confirmed_at: confirmedAt,
    attestation: LEGACY_RECOVERY_ATTESTATION,
    source_sha256: sourceSha256,
    recovered_state_sha256: createHash("sha256").update(finalStateContent, "utf8").digest("hex"),
    raw_backup_path: paths.backup,
    recognized_legacy_keys: recognizedLegacyKeys,
    repairs,
    checkpoint_authorization: "none_inferred",
  };
  return {
    context,
    state_bytes: stateBytes,
    state_file: lifecycleContent(stateBytes),
    control_file: lifecycleContent(optionalRawFile(controlPath(options.cwd))),
    state_content: finalStateContent,
    state,
    recovery_id: sourceSha256,
    source_sha256: sourceSha256,
    raw_backup_path: paths.backup,
    receipt_path: paths.receipt,
    receipt_content: JSON.stringify(receipt, null, 2) + "\n",
    confirmed_at: confirmedAt,
    summary,
  };
}

function inspectLegacyCtoRecovery(
  options: CtoIngressOptions,
  context: TrustedExecutionContext,
  confirmedAt: string,
): LegacyCtoRecoverySnapshot {
  return withWorkspaceReadNoRecovery(
    options.cwd,
    () => {
      const statePath = ctoStatePath(options.run_id!, options.cwd);
      const stateBytes = optionalRawFile(statePath);
      if (stateBytes === null) throw new LifecycleError("run_not_found", "legacy CTO run '" + options.run_id + "' is missing", { run_id: options.run_id });
      const control = readRunControlNoRecovery(options.cwd);
      return buildLegacyRecoverySnapshot(options, context, stateBytes, control, confirmedAt);
    },
    () => { throw new LifecycleError("run_not_found", "legacy CTO run '" + options.run_id + "' is missing", { run_id: options.run_id }); },
  );
}

/**
 * Explicit host-confirmed recovery for a claimless legacy CTO state. Normal
 * ingress deliberately does not call this path: the caller must opt in,
 * present the exact run, and obtain an interactive attestation.
 */
export async function recoverLegacyCtoIngress(
  options: CtoIngressOptions,
  confirm: (summary: string) => Promise<boolean>,
): Promise<CtoIngressResult | undefined> {
  const runId = options.run_id;
  if (typeof runId !== "string" || !/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..") {
    throw new LifecycleError("lifecycle_request_conflict", "legacy CTO recovery requires an exact run_id", { run_id: runId });
  }
  if (typeof confirm !== "function") {
    throw new LifecycleError("lifecycle_request_conflict", "legacy CTO recovery requires interactive host confirmation", { run_id: runId });
  }
  const context = assertContext(options.controller, options.cwd, options.branch);
  if (ctoClaimCredentials(options.controller) || options.controller.activeCtoClaim()) {
    throw new LifecycleError("run_busy", "legacy CTO recovery requires a fresh unbound coordinator", { run_id: runId });
  }
  const preflightAt = new Date().toISOString();
  const preflight = inspectLegacyCtoRecovery(options, context, preflightAt);
  if (!(await confirm(preflight.summary))) return undefined;
  const confirmedAt = new Date().toISOString();
  const postContext = assertContext(options.controller, options.cwd, options.branch);
  if (!sameTrustedContext(context, postContext)) {
    throw new LifecycleError("lifecycle_request_conflict", "trusted coordinator identity changed while legacy recovery was being confirmed", { run_id: runId, next_action: "start recovery again from the same host coordinator" });
  }

  let claimResult: ClaimResult | undefined;
  let recoveredState: CtoState | undefined;
  let publishedSnapshot: LegacyCtoRecoverySnapshot | undefined;
  withWorkspaceTransaction(options.cwd, () => {
    const lockedContext = assertContext(options.controller, options.cwd, options.branch);
    if (!sameTrustedContext(postContext, lockedContext)) {
      throw new LifecycleError("lifecycle_request_conflict", "trusted coordinator identity changed before the recovery transaction", { run_id: runId, next_action: "start recovery again from the same host coordinator" });
    }
    const current = inspectLegacyCtoRecovery(options, lockedContext, confirmedAt);
    publishedSnapshot = current;
    if (!current.state_bytes.equals(preflight.state_bytes)) {
      throw new LifecycleError("lifecycle_request_conflict", "legacy CTO state changed while recovery confirmation was pending", { run_id: runId, next_action: "reread the exact legacy run and ask for confirmation again" });
    }
    if (!sameLifecycleContent(current.control_file, preflight.control_file)) {
      throw new LifecycleError("lifecycle_request_conflict", "legacy CTO run-control changed while recovery confirmation was pending", { run_id: runId, next_action: "reread the exact legacy run and ask for confirmation again" });
    }
    claimResult = publishCtoClaim(options.cwd, {
      run_id: runId,
      branch: options.branch,
      context: postContext,
      state_content: current.state_content,
      state_snapshot: { branch: options.branch, terminal: false, owner_session: postContext.session_id },
      legacy_recovery: {
        expected_state: current.state_file,
        backup_path: current.raw_backup_path,
        backup_content: current.state_file,
        receipt_path: current.receipt_path,
        receipt_content: current.receipt_content,
      },
    });
    recoveredState = readCtoState(runId, options.cwd) ?? undefined;
  });
  if (!claimResult || !recoveredState || !publishedSnapshot) throw new LifecycleError("recovery_required", "legacy CTO recovery did not publish a state claim", { run_id: runId });
  bindCtoClaim(options.controller, claimResult.claim);
  rememberCtoController(options.controller, options.cwd, claimResult.claim);
  bindCtoTerminalTransition(recoveredState, claimResult.claim, () => clearCtoClaimIfCurrent(options.controller, claimResult!.claim));
  return {
    run_id: runId,
    state: recoveredState,
    claim: claimResult,
    statePath: ctoStatePath(runId, options.cwd),
    created: false,
    standby: recoveredState.standby === true,
    recovery: {
      recovery_id: publishedSnapshot.recovery_id,
      source_sha256: publishedSnapshot.source_sha256,
      raw_backup_path: publishedSnapshot.raw_backup_path,
      receipt_path: publishedSnapshot.receipt_path,
    },
  };
}

function assertContext(
  controller: WorkflowSessionController,
  cwd: string,
  branch: string,
): TrustedExecutionContext {
  const context = controller.context();
  assertTrustedExecutionContext(context);
  if (context.caller !== "host" || context.authority !== "coordinator") {
    throw new LifecycleError("lifecycle_request_conflict", "CTO ingress requires a trusted host coordinator context", { branch });
  }
  if (context.worktree !== cwd || context.branch !== branch) {
    throw new LifecycleError("run_context_mismatch", "CTO ingress context does not match the requested worktree or branch", { branch });
  }
  return context;
}

/**
 * Registered `/cto` ingress. A minimal canonical state and its claim are
 * published in one lifecycle transaction before the prompt is sent.
 */
export function acquireCtoIngress(options: CtoIngressOptions): CtoIngressResult {
  if (options.run_id !== undefined && (!/^[A-Za-z0-9._-]+$/.test(options.run_id) || options.run_id === "." || options.run_id === "..")) {
    throw new LifecycleError("lifecycle_request_conflict", `invalid exact CTO run id '${options.run_id}'`, { run_id: options.run_id });
  }
  const context = assertContext(options.controller, options.cwd, options.branch);
  reconcileCtoTerminalRecovery(options.controller, options.cwd);
  const existingBinding = ctoClaimCredentials(options.controller);
  const activeBinding = options.controller.activeCtoClaim();
  if (existingBinding && (!activeBinding || activeBinding.run_id !== existingBinding.run_id || activeBinding.ownership_epoch !== existingBinding.ownership_epoch)) {
    throw new LifecycleError("run_busy", "the current host session has a stale CTO ownership binding", { run_id: existingBinding.run_id, next_action: "reconcile the previous CTO session before starting another command" });
  }

  let runId = options.run_id;
  let state: CtoState | null = null;
  let created = false;
  if (runId) {
    const evidence = ctoStateEvidence(options.cwd, runId);
    if (evidence.kind === "absent") throw new LifecycleError("run_not_found", `CTO run '${runId}' is missing`, { run_id: runId });
    if (evidence.kind === "corrupt" || evidence.kind === "markdown-only") {
      throw new LifecycleError("recovery_required", `CTO run '${runId}' is unreadable or markdown-only`, { run_id: runId, next_action: "repair or explicitly reconcile the legacy CTO run" });
    }
    state = evidence.state;
    if (isCtoRunTerminal(state)) throw new LifecycleError("run_terminal", `CTO run '${runId}' is terminal`, { run_id: runId });
    if (state.branch !== options.branch) {
      throw new LifecycleError("run_context_mismatch", `CTO run '${runId}' belongs to branch '${state.branch}'`, { run_id: runId, branch: state.branch });
    }
  } else if (activeBinding) {
    runId = activeBinding.run_id;
    const evidence = ctoStateEvidence(options.cwd, runId);
    if (evidence.kind !== "valid") {
      throw new LifecycleError("recovery_required", `bound CTO run '${runId}' is unreadable`, { run_id: runId });
    }
    state = evidence.state;
    if (isCtoRunTerminal(state)) throw new LifecycleError("run_terminal", `CTO run '${runId}' is terminal`, { run_id: runId });
    if (state.branch !== options.branch) {
      throw new LifecycleError("run_context_mismatch", `CTO run '${runId}' belongs to branch '${state.branch}'`, { run_id: runId, branch: state.branch });
    }
  } else {
    const control = readRunControlNoRecovery(options.cwd);
    if (control.execution_claim) {
      throw new LifecycleError("run_busy", `worktree execution is owned by run '${control.execution_claim.run_id}'`, { run_id: control.execution_claim.run_id, next_action: "resume or reconcile the existing run" });
    }
    const legacyActive = activeLegacyCtoStateIds(options.cwd).filter((id) => !Object.prototype.hasOwnProperty.call(control.cto_releases, id));
    if (legacyActive.length > 0) {
      throw new LifecycleError("run_selection_required", `active legacy CTO run '${legacyActive[0]}' requires an explicit --run selector`, { run_id: legacyActive[0], next_action: "use /cto --run <exact-cto-id>" });
    }
    runId = ctoRunId(options.task || "standby");
    const noTask = options.task.trim().length === 0;
    const plan: TeamPlan = { id: runId, task: noTask ? "standby — awaiting inbox tasks" : options.task, teams: [], created_at: new Date().toISOString() };
    state = newCtoState({
      id: runId,
      task: plan.task,
      branch: options.branch,
      autonomous: noTask,
      plan,
      // Every newly created registered /cto ingress is a resident
      // coordinator. A task-backed run may start wave 1 immediately; after
      // that wave closes the same run remains claimable until explicit END.
      standby: true,
      owner_session: context.session_id,
    });
    created = true;
  }
  if (!state || !runId) throw new LifecycleError("run_state_invalid", "CTO ingress did not resolve a state");
  const stateContent = created ? `${JSON.stringify(state, null, 2)}\n` : undefined;
  const claim = publishCtoClaim(options.cwd, {
    run_id: runId,
    branch: options.branch,
    context,
    ...(stateContent ? { state_content: stateContent } : {}),
    state_snapshot: {
      branch: state.branch,
      terminal: false,
      ...(state.owner_session ? { owner_session: state.owner_session } : {}),
    },
    ...(!created && !activeBinding ? { legacy_owner_session_id: context.session_id } : {}),
  } satisfies CtoClaimPublication);
  bindCtoClaim(options.controller, claim.claim);
  rememberCtoController(options.controller, options.cwd, claim.claim);
  bindCtoTerminalTransition(state, claim.claim, () => clearCtoClaimIfCurrent(options.controller, claim.claim));
  return {
    run_id: claim.claim.run_id,
    state,
    claim,
    statePath: ctoStatePath(runId, options.cwd),
    created,
    standby: state.standby === true,
  };
}

function releaseCtoClaim(
  cwd: string,
  context: TrustedExecutionContext,
  runId: string,
  token: string,
  reason: CtoReleaseProvenance["reason"],
  requireTerminal: boolean,
): boolean {
  assertTrustedExecutionContext(context);
  return withWorkspaceTransaction(cwd, () => {
    const state = readCtoState(runId, cwd);
    if (!state) throw new LifecycleError("recovery_required", `CTO run '${runId}' is unreadable`, { run_id: runId });
    if (state.branch !== context.branch) {
      throw new LifecycleError("run_context_mismatch", `CTO run '${runId}' branch does not match the trusted host context`, { run_id: runId, branch: state.branch });
    }
    const control = readRunControlNoRecovery(cwd);
    const claim = control.execution_claim;
    if (
      !claim
      || claim.owner_kind !== "cto"
      || claim.run_id !== runId
      || claim.token !== token
      || claim.released_at !== null
      || claim.coordinator_session_id !== context.session_id
      || (claim.coordinator_process_id ?? undefined) !== (context.process_id ?? undefined)
    ) {
      throw new LifecycleError("run_busy", "CTO claim is no longer owned by the authenticated coordinator", { run_id: runId, next_action: "reacquire the exact CTO run" });
    }
    if (requireTerminal && !isCtoRunTerminal(state)) return false;
    const pending = hasOutstandingCtoWork(state);
    const existingRelease = control.cto_releases[runId];
    if (existingRelease?.issuance_token === claim.token) {
      throw new LifecycleError("recovery_required", "CTO release provenance would overwrite its original issuance", { run_id: runId, next_action: "reconcile the existing managed CTO release before releasing" });
    }
    const provenance = existingRelease
      ? (() => {
        if (
          existingRelease.pending_worker_ids.length !== claim.worker_ids.length
          || existingRelease.pending_worker_ids.some((workerId, index) => workerId !== claim.worker_ids[index])
        ) {
          throw new LifecycleError("recovery_required", "resumed CTO claim does not match the mutable reservation ledger", { run_id: runId, next_action: "reconcile the managed CTO reservation ledger before releasing" });
        }
        return {
          ...existingRelease,
          pending_worker_ids: [...claim.worker_ids],
          current_snapshot_hash: releaseSnapshotHash(cwd, runId),
        };
      })()
      : releaseProvenance(cwd, state, context, reason, claim);
    releaseExecutionClaim(cwd, {
      run_id: runId,
      token,
      receipt: provenance.release_receipt,
      retain_reservation: pending,
      cto_release: provenance,
    });
    return true;
  });
}

export function suspendCtoSession(controller: WorkflowSessionController, reason: "session-shutdown" | "session-replacement"): void {
  const credentials = ctoClaimCredentials(controller);
  if (!credentials) return;
  const scope = controller.activeCtoClaim();
  if (!scope || scope.run_id !== credentials.run_id || scope.ownership_epoch !== credentials.ownership_epoch) {
    throw new LifecycleError("run_busy", "CTO session binding is stale or no longer owns its claim", { run_id: credentials.run_id });
  }
  releaseCtoClaim(controller.context().worktree, controller.context(), credentials.run_id, credentials.token, reason, false);
  clearCtoClaimIfCurrent(controller, credentials);
}

export function finalizeCtoSession(controller: WorkflowSessionController): void {
  const credentials = ctoClaimCredentials(controller);
  if (!credentials) return;
  const scope: CtoClaimScope | undefined = controller.activeCtoClaim();
  if (!scope || scope.run_id !== credentials.run_id || scope.ownership_epoch !== credentials.ownership_epoch) {
    throw new LifecycleError("run_busy", "CTO session binding is stale or no longer owns its claim", { run_id: credentials.run_id });
  }
  if (releaseCtoClaim(controller.context().worktree, controller.context(), credentials.run_id, credentials.token, "terminal", true)) {
    clearCtoClaimIfCurrent(controller, credentials);
  }
}

export function runCto(opts: RunCtoOptions): RunCtoResult {
  if (!opts.execution) throw new LifecycleError("lifecycle_request_conflict", "trusted execution context is required for CTO lifecycle mutation");
  assertTrustedExecutionContext(opts.execution);
  if (opts.execution.worktree !== opts.cwd) {
    throw new LifecycleError("run_context_mismatch", "trusted execution context does not match the CTO worktree", { branch: opts.branch });
  }
  if (opts.execution.branch !== opts.branch) {
    throw new LifecycleError("run_context_mismatch", "trusted execution context does not match the CTO branch", { branch: opts.branch });
  }

  const built = buildTeamPlan({ id: ctoRunId(opts.task), task: opts.task, teams: opts.teams }, opts.defs);
  if (!built.ok) return built;
  const depth = validateDecompositionDepth(built.plan, opts.profileDepth);
  if (!depth.ok) return { ok: false, reason: depth.reason };
  const state = newCtoState({
    id: built.plan.id,
    task: opts.task,
    branch: opts.branch,
    autonomous: opts.autonomous,
    classification: opts.classification,
    plan: built.plan,
    ...(opts.standby === true ? { standby: true } : {}),
    ...(opts.owner_session ? { owner_session: opts.owner_session } : {}),
  });
  const claim = publishCtoClaim(opts.cwd, {
    run_id: built.plan.id,
    branch: opts.branch,
    context: opts.execution,
    state_content: `${JSON.stringify(state, null, 2)}\n`,
    state_snapshot: { branch: state.branch, terminal: false, ...(state.owner_session ? { owner_session: state.owner_session } : {}) },
  });
  bindCtoTerminalTransition(state, claim.claim);
  const statePath = ctoStatePath(built.plan.id, opts.cwd);
  opts.log?.(`cto: plan ${built.plan.id} — ${built.plan.teams.length} teams, depth ${depth.depth}, state ${statePath}`);
  return { ok: true, plan: built.plan, state, statePath };
}

function commitInternalTerminalTransition(
  candidate: CtoState,
  cwd: string,
  proof: CtoTerminalTransitionProof,
): boolean {
  try {
    validateCtoStateCandidate(candidate, candidate.id);
  } catch (error) {
    throw new LifecycleError("run_state_invalid", `CTO terminal candidate is invalid: ${(error as Error).message}`, { run_id: candidate.id });
  }
  return withWorkspaceTransaction(cwd, () => {
    const statePath = ctoStatePath(candidate.id, cwd);
    let beforeState: string;
    try {
      beforeState = readFileSync(statePath, "utf8");
    } catch {
      throw new LifecycleError("recovery_required", `CTO run '${candidate.id}' is unreadable`, { run_id: candidate.id });
    }
    const originatingSnapshot = ctoStateSnapshot(candidate);
    if (originatingSnapshot === undefined) {
      throw new LifecycleError("run_busy", "CTO terminal transition requires the originating state snapshot", { run_id: candidate.id, next_action: "reread the exact CTO run before finalizing" });
    }
    if (originatingSnapshot !== beforeState) {
      throw new LifecycleError("lifecycle_request_conflict", "CTO terminal transition is stale; the canonical state changed after the originating read", { run_id: candidate.id, next_action: "reread and settle the current CTO work before finalizing" });
    }
    let currentDecoded: unknown;
    try {
      currentDecoded = JSON.parse(beforeState);
    } catch {
      throw new LifecycleError("recovery_required", `CTO run '${candidate.id}' state is not valid JSON`, { run_id: candidate.id });
    }
    const currentParsed = parseCtoState(currentDecoded, candidate.id);
    if (!currentParsed.ok) {
      throw new LifecycleError("recovery_required", `CTO run '${candidate.id}' state is invalid: ${currentParsed.error}`, { run_id: candidate.id });
    }
    const currentTypedValidation = validateTypedControlPlane(currentDecoded);
    if (!currentTypedValidation.ok) {
      throw new LifecycleError(
        "recovery_required",
        `CTO run '${candidate.id}' typed control-plane state is invalid: ${currentTypedValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
        { run_id: candidate.id, next_action: "repair the canonical CTO state before continuing" },
      );
    }
    const current = currentParsed.state;
    if (
      !isCtoRunTerminal(candidate)
      || current.branch !== candidate.branch
      || current.branch !== proof.branch
      || current.id !== proof.run_id
      || !terminalBarrierSettlement(current, candidate)
    ) {
      throw new LifecycleError("run_busy", "CTO terminal transition does not settle the current state barriers", { run_id: candidate.id, next_action: "reread and settle the current CTO work before publishing terminal state" });
    }
    const controlBefore = readFileSync(controlPath(cwd), "utf8");
    const control = readRunControlNoRecovery(cwd);
    const claim = control.execution_claim;
    if (
      !claim
      || claim.owner_kind !== "cto"
      || claim.run_id !== candidate.id
      || claim.token !== proof.token
      || claim.ownership_epoch !== proof.ownership_epoch
      || claim.coordinator_session_id !== proof.coordinator_session_id
      || (claim.coordinator_process_id ?? undefined) !== (proof.coordinator_process_id ?? undefined)
      || claim.released_at !== null
    ) {
      throw new LifecycleError("run_busy", "CTO terminal transition requires the current coordinator claim", { run_id: candidate.id, next_action: "reacquire the exact CTO run before publishing terminal state" });
    }
    if (
      claim.worker_ids.length > 0
      || hasOutstandingCtoWork(candidate)
      || hasOutstandingCtoWork(current) && !terminalBarrierSettlement(current, candidate)
    ) {
      throw new LifecycleError("run_busy", "terminal CTO state cannot bypass pending worker reservations or barriers", { run_id: candidate.id, next_action: "settle the pending CTO work before publishing terminal state" });
    }
    const stateContent = `${JSON.stringify(candidate, null, 2)}\n`;
    const nextStateRevision = ctoStateRevision(stateContent);
    const existingRelease = control.cto_releases[candidate.id];
    if (existingRelease?.issuance_token === claim.token) {
      throw new LifecycleError("recovery_required", "CTO terminal transition would overwrite its original issuance provenance", { run_id: candidate.id, next_action: "reconcile the existing CTO release before committing terminal state" });
    }
    let provenance: CtoReleaseProvenance;
    if (existingRelease) {
      if (
        existingRelease.pending_worker_ids.length !== claim.worker_ids.length
        || existingRelease.pending_worker_ids.some((workerId, index) => workerId !== claim.worker_ids[index])
      ) {
        throw new LifecycleError("recovery_required", "CTO terminal transition does not match the mutable reservation ledger", { run_id: candidate.id, next_action: "settle the pending CTO reservations before committing terminal state" });
      }
      provenance = {
        ...existingRelease,
        pending_worker_ids: [...claim.worker_ids],
        current_snapshot_hash: nextStateRevision,
      };
    } else {
      const context: TrustedExecutionContext = {
        session_id: proof.coordinator_session_id,
        caller: "host",
        ...(proof.coordinator_process_id ? { process_id: proof.coordinator_process_id } : {}),
        worktree: cwd,
        branch: proof.branch,
        authority: "coordinator",
      };
      provenance = releaseProvenance(cwd, candidate, context, "terminal", claim, nextStateRevision);
    }
    const nextControl: RunControl = {
      ...control,
      revision: control.revision + 1,
      execution_claim: null,
      cto_releases: { ...control.cto_releases, [candidate.id]: provenance },
    };
    const afterControl = `${JSON.stringify(nextControl, null, 2)}\n`;
    const transaction = beginLifecycleTransaction({
      cwd,
      operation: "resume",
      before: { [statePath]: beforeState, [controlPath(cwd)]: controlBefore },
      after: {
        [statePath]: stateContent,
        [controlPath(cwd)]: afterControl,
      },
    });
    const controller = ctoControllersByClaim.get(ctoClaimBindingKey(cwd, proof));
    if (controller) {
      pendingCtoTerminalRecoveries.set(transaction.transaction_id, {
        transaction_id: transaction.transaction_id,
        controller,
        cwd,
        run_id: candidate.id,
        token: proof.token,
        ownership_epoch: proof.ownership_epoch,
        coordinator_session_id: proof.coordinator_session_id,
        ...(proof.coordinator_process_id === undefined ? {} : { coordinator_process_id: proof.coordinator_process_id }),
        branch: proof.branch,
        after_state: stateContent,
        after_control: afterControl,
      });
    }
    commitLifecycleTransaction(cwd, transaction.transaction_id);
    if (controller) {
      pendingCtoTerminalRecoveries.delete(transaction.transaction_id);
      clearCtoClaimIfCurrent(controller, proof);
    }
    return true;
  });
}


export function finalizeCtoExecution(cwd: string, runId: string, token?: string): void {
  if (!token) {
    throw new LifecycleError("run_busy", "CTO terminal finalization requires the originating ownership token", { run_id: runId });
  }
  withWorkspaceReadNoRecovery(
    cwd,
    () => {
      const state = readCtoState(runId, cwd);
      if (!state) throw new LifecycleError("recovery_required", `CTO run '${runId}' is unreadable`, { run_id: runId });
      const claim = readRunControlNoRecovery(cwd).execution_claim;
      if (!claim || claim.owner_kind !== "cto" || claim.run_id !== runId) return;
      if (claim.token !== token) throw new LifecycleError("run_busy", "CTO terminal finalization token does not match the current claim", { run_id: runId });
      commitInternalTerminalTransition(state, cwd, {
        run_id: runId,
        token,
        ownership_epoch: claim.ownership_epoch,
        coordinator_session_id: claim.coordinator_session_id,
        ...(claim.coordinator_process_id ? { coordinator_process_id: claim.coordinator_process_id } : {}),
        branch: state.branch,
      });
    },
    () => {
      throw new LifecycleError("recovery_required", `CTO run '${runId}' is unreadable`, { run_id: runId });
    },
  );
}

registerCtoTerminalTransitionHook((state, root, proof, phase) => {
  if (phase !== "before") {
    throw new LifecycleError("run_state_invalid", "CTO terminal transition after-phase publication is unsupported", { run_id: state.id });
  }
  if (!proof) throw new LifecycleError("run_busy", "CTO terminal transition requires the originating ownership proof", { run_id: state.id });
  return commitInternalTerminalTransition(state, root, proof);
});
