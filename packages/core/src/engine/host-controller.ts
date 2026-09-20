import {
  readRunControl,
  readRunState,
  restoreDispatchOrigins,
  selectSession,
  deactivateSessionSelection,
  releaseExecutionClaim,
  type ClaimResult,
} from "./run-store.js";
import {
  assertTrustedExecutionContext,
  LifecycleError,
  type LifecycleSelector,
} from "./run-lifecycle.js";
import {
  prepareWorkflowState,
  type PreparedWorkflowState,
  type WorkflowPrepareOptions,
} from "./run.js";
import { createWorkflowReadSelector, type WorkflowReadSelector } from "./read-selector.js";
import type { LifecycleMode, TrustedExecutionContext } from "./types.js";

export interface WorkflowSessionControllerOptions {
  cwd: string;
  context: TrustedExecutionContext;
  owner_kind?: "workflow" | "cto";
}

export type WorkflowControllerPrepareRequest = Omit<WorkflowPrepareOptions, "cwd" | "branch" | "execution" | "task"> & {
  task?: string;
  mode: LifecycleMode;
  run_id?: string;
  selector?: LifecycleSelector;
  snapshot?: import("./types.js").RunSelectionSnapshot;
};

export interface WorkflowSessionController {
  context(): TrustedExecutionContext;
  readSelector(): WorkflowReadSelector;
  /** Current run explicitly bound by this session, if any; never performs CLI selection. */
  selectedRunId(): string | undefined;
  prepare(request: WorkflowControllerPrepareRequest): PreparedWorkflowState;
  bind(runId: string, token?: string): void;
  release(receipt?: string): void;
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
  const trusted = structuredClone(options.context);
  assertTrustedExecutionContext(trusted);
  if (trusted.worktree !== cwd) {
    throw new LifecycleError("run_context_mismatch", "session controller worktree does not match cwd", { branch: trusted.branch });
  }
  const selector = createWorkflowReadSelector(cwd, { branch: trusted.branch, session_run_id: undefined });
  let boundRunId: string | undefined;
  let boundToken: string | undefined;

  function bindClaim(runId: string, token?: string): void {
    boundRunId = runId;
    boundToken = token;
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
    if (!boundRunId || !boundToken) return;
    releaseExecutionClaim(cwd, { run_id: boundRunId, token: boundToken, ...(receipt ? { receipt } : {}) });
    boundToken = undefined;
    boundRunId = undefined;
  }

  return {
    context: () => structuredClone(trusted),
    readSelector: () => selector,
    selectedRunId: () => {
      if (boundRunId) {
        const state = readRunState(cwd, boundRunId);
        if (!state || state.lifecycle_status === "complete" || state.pause?.kind === "done") {
          boundRunId = undefined;
          boundToken = undefined;
          try { deactivateSessionSelection(cwd, trusted.session_id); } catch { /* preserve history; fail closed */ }
          return undefined;
        }
        return boundRunId;
      }
      const selection = readRunControl(cwd).selections[trusted.session_id];
      if (!selection?.active) return undefined;
      const state = readRunState(cwd, selection.run_id);
      if (!state || state.lifecycle_status === "complete" || state.pause?.kind === "done") {
        try { deactivateSessionSelection(cwd, trusted.session_id); } catch { /* preserve history; fail closed */ }
        return undefined;
      }
      return selection.run_id;
    },
    prepare,
    bind: bindClaim,
    release,
  };
}
