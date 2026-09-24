import {
  readRunControl,
  readRunControlNoRecovery,
  readRunState,
  readRunStateNoRecovery,
  restoreDispatchOrigins,
  selectSession,
  deactivateSessionSelection,
  releaseExecutionClaim,
  type ClaimResult,
} from "./run-store.js";
import {
  assertTrustedExecutionContext,
  createLifecycleRequestId,
  LifecycleError,
  type LifecycleSelector,
} from "./run-lifecycle.js";
import {
  prepareWorkflowState,
  type PreparedWorkflowState,
  type WorkflowPrepareOptions,
} from "./run.js";
import { createWorkflowReadSelector, type WorkflowReadSelector } from "./read-selector.js";
import type { CtoClaimScope, LifecycleMode, RunSelectionSnapshot, TrustedExecutionContext, WorktreeExecutionClaim } from "./types.js";

export interface WorkflowSessionControllerOptions {
  cwd: string;
  context: TrustedExecutionContext;
  owner_kind?: "workflow" | "cto";
}

export type WorkflowCommandIntentMode = Exclude<LifecycleMode, "list">;

/** Trusted binding issued by a user-entered explicit lifecycle command. */
export interface WorkflowCommandIntent {
  intent_id: string;
  mode: WorkflowCommandIntentMode;
  run_id?: string;
}

/** Model/tool input used to validate an issued command binding. */
export interface WorkflowCommandIntentInput {
  command_intent_id?: string;
  mode: LifecycleMode;
  run_id?: string;
}

export type WorkflowControllerPrepareRequest = Omit<WorkflowPrepareOptions, "cwd" | "branch" | "execution" | "task"> & {
  task?: string;
  mode: LifecycleMode;
  run_id?: string;
  selector?: LifecycleSelector;
  snapshot?: RunSelectionSnapshot;
};

export interface WorkflowSessionController {
  context(): TrustedExecutionContext;
  readSelector(): WorkflowReadSelector;
  /** Current run explicitly bound by this session, if any; never performs CLI selection. */
  selectedRunId(): string | undefined;
  /**
   * Return the run whose canonical execution claim is still owned by this
   * controller, or undefined when the binding is idle, replaced, released,
   * or unreadable. This is a read-only proof and never repairs state.
   */
  activeClaimRunId(): string | undefined;
  /**
   * Exact non-secret scope of the current authenticated CTO claim. A bound
   * token that cannot be verified is a typed refusal, never ordinary absence.
   */
  activeCtoClaim(): CtoClaimScope | undefined;
  /** Issue a one-shot opaque binding for an explicit user lifecycle command. */
  issueCommandIntent(mode: WorkflowCommandIntentMode, run_id?: string): WorkflowCommandIntent;
  /** Validate and reserve the issued binding before workflow_prepare mutates state. */
  consumeCommandIntent(input: WorkflowCommandIntentInput): WorkflowCommandIntent | undefined;
  /** Finalize a reserved binding only after canonical workflow preparation succeeds. */
  commitCommandIntent(intent_id: string): void;
  /** Clear a pending or reserved command binding. */
  clearCommandIntent(): void;
  prepare(request: WorkflowControllerPrepareRequest): PreparedWorkflowState;
  bind(runId: string, token?: string): void;
  release(receipt?: string): void;
}

export interface CtoClaimCredentials {
  readonly run_id: string;
  readonly token: string;
  readonly ownership_epoch: string;
}

const ctoClaimBindings = new WeakMap<WorkflowSessionController, CtoClaimCredentials>();

function exactActiveClaim(
  claim: unknown,
  expectedOwnerKind: "workflow" | "cto",
  runId: string,
  token: string,
  context: TrustedExecutionContext,
): boolean {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
  const value = claim as Record<string, unknown>;
  return value.owner_kind === expectedOwnerKind
    && value.run_id === runId
    && value.token === token
    && typeof value.token === "string"
    && value.token.length > 0
    && value.coordinator_session_id === context.session_id
    && value.coordinator_process_id === context.process_id
    && value.released_at === null
    && typeof value.ownership_epoch === "string"
    && value.ownership_epoch.length > 0
    && Array.isArray(value.worker_ids)
    && value.worker_ids.every((workerId) => typeof workerId === "string" && workerId.length > 0);
}

/** Internal domain seam: only the CTO adapter can bind its private token. */
export function bindCtoClaim(controller: WorkflowSessionController, claim: WorktreeExecutionClaim): void {
  if (claim.owner_kind !== "cto" || claim.released_at !== null) {
    throw new LifecycleError("run_busy", "cannot bind an inactive CTO execution claim", { run_id: claim.run_id });
  }
  ctoClaimBindings.set(controller, {
    run_id: claim.run_id,
    token: claim.token,
    ownership_epoch: claim.ownership_epoch,
  });
}

export function ctoClaimCredentials(controller: WorkflowSessionController): CtoClaimCredentials | undefined {
  const value = ctoClaimBindings.get(controller);
  return value ? { ...value } : undefined;
}

export function clearCtoClaim(controller: WorkflowSessionController): void {
  ctoClaimBindings.delete(controller);
}

function activeCtoClaimFor(controller: WorkflowSessionController, context: TrustedExecutionContext, cwd: string): CtoClaimScope | undefined {
  const binding = ctoClaimBindings.get(controller);
  if (!binding) return undefined;
  let claim: unknown;
  try {
    claim = readRunControlNoRecovery(cwd).execution_claim;
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError("recovery_required", "bound CTO claim could not be verified", { run_id: binding.run_id, next_action: "recover lifecycle state before continuing" });
  }
  if (!exactActiveClaim(claim, "cto", binding.run_id, binding.token, context)) {
    throw new LifecycleError("run_busy", "bound CTO claim is no longer current", { run_id: binding.run_id, next_action: "resume or reconcile the current coordinator before continuing" });
  }
  const value = claim as Record<string, unknown>;
  if (value.ownership_epoch !== binding.ownership_epoch) {
    throw new LifecycleError("run_busy", "bound CTO claim ownership epoch is stale", { run_id: binding.run_id, next_action: "resume or reconcile the current coordinator before continuing" });
  }
  return { run_id: binding.run_id, ownership_epoch: binding.ownership_epoch };
}

function selectionRunId(
  selector: WorkflowReadSelector,
  mode: Exclude<LifecycleMode, "new">,
  request: WorkflowControllerPrepareRequest,
): string {
  if (request.run_id) return request.run_id;
  const result = selector.resolve(mode, request.selector, request.snapshot);
  if (result.ok) return result.candidate.run_id;
  throw result.error;
}

export function createWorkflowSessionController(options: WorkflowSessionControllerOptions): WorkflowSessionController {
  const cwd = options.cwd;
  const expectedOwnerKind = options.owner_kind ?? "workflow";
  const trusted = structuredClone(options.context);
  assertTrustedExecutionContext(trusted);
  if (trusted.worktree !== cwd) {
    throw new LifecycleError("run_context_mismatch", "session controller worktree does not match cwd", { branch: trusted.branch });
  }
  const selector = createWorkflowReadSelector(cwd, { branch: trusted.branch, session_run_id: undefined });
  let boundRunId: string | undefined;
  let boundToken: string | undefined;
  let commandIntent: WorkflowCommandIntent | undefined;
  let consumedCommandIntentId: string | undefined;

  function activeClaimRunId(): string | undefined {
    if (!boundRunId || !boundToken) return undefined;
    try {
      const claim = readRunControlNoRecovery(cwd).execution_claim;
      return exactActiveClaim(claim, expectedOwnerKind, boundRunId, boundToken, trusted) ? boundRunId : undefined;
    } catch {
      return undefined;
    }
  }

  function bindClaim(runId: string, token?: string): void {
    boundRunId = runId;
    boundToken = token;
  }

  function issueCommandIntent(mode: WorkflowCommandIntentMode, run_id?: string): WorkflowCommandIntent {
    const next: WorkflowCommandIntent = {
      intent_id: createLifecycleRequestId(),
      mode,
      ...(run_id ? { run_id } : {}),
    };
    commandIntent = next;
    consumedCommandIntentId = undefined;
    return { ...next };
  }

  function commandIntentConflict(message: string): never {
    throw new LifecycleError("lifecycle_request_conflict", message, {
      ...(commandIntent?.run_id ? { run_id: commandIntent.run_id } : {}),
    });
  }

  function consumeCommandIntent(input: WorkflowCommandIntentInput): WorkflowCommandIntent | undefined {
    const pending = commandIntent;
    if (!pending) {
      if (input.command_intent_id) commandIntentConflict("command intent token is not pending or has already been consumed");
      return undefined;
    }
    if (!input.command_intent_id) commandIntentConflict("workflow_prepare requires the pending command intent token");
    if (input.command_intent_id !== pending.intent_id) commandIntentConflict("workflow_prepare command intent token does not match the pending command");
    if (input.mode !== pending.mode) commandIntentConflict(`workflow_prepare mode '${input.mode}' does not match explicit command mode '${pending.mode}'`);
    // An explicitly bound --run must match byte-for-byte. Without --run, the
    // trusted token intentionally survives selector/read-only errors so the
    // model may retry with the selected run_id from the returned snapshot.
    if (pending.run_id !== undefined && pending.run_id !== input.run_id) {
      commandIntentConflict(`workflow_prepare run_id '${input.run_id ?? "(missing)"}' does not match explicit command run '${pending.run_id}'`);
    }
    consumedCommandIntentId = pending.intent_id;
    return { ...pending };
  }

  function commitCommandIntent(intent_id: string): void {
    if (!commandIntent || commandIntent.intent_id !== intent_id || consumedCommandIntentId !== intent_id) {
      commandIntentConflict("workflow_prepare command intent token is not reserved or has already been consumed");
    }
    commandIntent = undefined;
    consumedCommandIntentId = undefined;
  }

  function clearCommandIntent(): void {
    commandIntent = undefined;
    consumedCommandIntentId = undefined;
  }

  function prepare(request: WorkflowControllerPrepareRequest): PreparedWorkflowState {
    if (request.mode === "new" && !request.task?.trim()) {
      throw new LifecycleError("lifecycle_request_conflict", "new workflow preparation requires a non-empty task");
    }
    const control = readRunControl(cwd);
    const activeSessionRun = control.selections[trusted.session_id]?.active
      ? control.selections[trusted.session_id]?.run_id
      : undefined;
    const runSelector = request.selector || !activeSessionRun
      ? selector
      : createWorkflowReadSelector(cwd, { branch: trusted.branch, session_run_id: activeSessionRun });
    const runId = request.mode === "new"
      ? undefined
      : selectionRunId(runSelector, request.mode, request);
    const prepared = prepareWorkflowState({
      ...request,
      task: request.task ?? "",
      cwd,
      branch: trusted.branch,
      execution: trusted,
      ...(runId ? { run_id: runId } : {}),
    });
    const claim = readRunControl(cwd).execution_claim;
    if (claim && claim.run_id === prepared.state.run_id) bindClaim(claim.run_id, claim.token);
    if (prepared.state.run_id) restoreDispatchOrigins(cwd, prepared.state.run_id);
    return prepared;
  }

  function release(receipt?: string): void {
    clearCommandIntent();
    if (!boundRunId || !boundToken) return;
    releaseExecutionClaim(cwd, { run_id: boundRunId, token: boundToken, ...(receipt ? { receipt } : {}) });
    boundToken = undefined;
    boundRunId = undefined;
  }

  const controller: WorkflowSessionController = {
    context: () => structuredClone(trusted),
    readSelector: () => selector,
    selectedRunId: () => {
      if (boundRunId) {
        const state = readRunStateNoRecovery(cwd, boundRunId);
        if (!state) {
          throw new LifecycleError("recovery_required", `bound workflow run '${boundRunId}' is missing or unreadable; recover lifecycle state before mutating`);
        }
        if (state.lifecycle_status === "complete" || state.pause?.kind === "done") {
          boundRunId = undefined;
          boundToken = undefined;
          try { deactivateSessionSelection(cwd, trusted.session_id); } catch { /* preserve history; fail closed */ }
          return undefined;
        }
        return boundRunId;
      }
      const selection = readRunControlNoRecovery(cwd).selections[trusted.session_id];
      if (!selection?.active) return undefined;
      const state = readRunStateNoRecovery(cwd, selection.run_id);
      if (!state) {
        throw new LifecycleError("recovery_required", `selected workflow run '${selection.run_id}' is missing or unreadable; recover lifecycle state before mutating`);
      }
      if (state.lifecycle_status === "complete" || state.pause?.kind === "done") {
        try { deactivateSessionSelection(cwd, trusted.session_id); } catch { /* preserve history; fail closed */ }
        return undefined;
      }
      return selection.run_id;
    },
    activeClaimRunId,
    activeCtoClaim: () => activeCtoClaimFor(controller, trusted, cwd),
    issueCommandIntent,
    consumeCommandIntent,
    commitCommandIntent,
    clearCommandIntent,
    prepare,
    bind: bindClaim,
    release,
  };
  return controller;
}
