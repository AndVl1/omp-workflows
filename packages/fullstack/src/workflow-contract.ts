import {
  createDiagnostic,
  failureResult,
  resolveWorkflowContract,
  successResult,
  WorkflowContractError,
  type DiagnosticResult,
  type RunValidatedDispatch,
  type WorkflowContract,
  type WorkflowName,
} from "@andvl1/omp-workflows-core";

/**
 * A report/contract request must originate from a host-validated run. The
 * branch is supplied by the active session manager; it is never read from
 * process state or selected from a cwd-only lookup.
 */
export interface FullstackWorkflowContractInput {
  readonly dispatch: RunValidatedDispatch;
  readonly branch: string;
  readonly workflow?: WorkflowName;
  readonly stageId?: string;
  readonly maxInstructions?: number;
}

function missingContext(message: string): DiagnosticResult<WorkflowContract> {
  return failureResult(createDiagnostic({
    code: "MIGRATION_REQUIRED",
    operation: "profile.resolve",
    remediation: message,
  }));
}

/**
 * Resolve one workflow contract from the exact validated project/run seam.
 * Core revalidates the identities, policy, catalog and inventory before reading
 * durable state; a malformed or incomplete caller is returned as diagnostics.
 */
export function resolveWorkflowCommandContract(
  input: FullstackWorkflowContractInput,
): DiagnosticResult<WorkflowContract> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return missingContext("Pass a host-validated RunValidatedDispatch and manager-supplied branch.");
  }
  if (!input.dispatch || input.dispatch.identity_level !== "run") {
    return missingContext("Workflow contracts require a core RunValidatedDispatch with an exact WorkflowRunIdentity.");
  }
  if (typeof input.branch !== "string" || input.branch.trim().length === 0) {
    return missingContext("Workflow contracts require the canonical branch from the active session manager.");
  }

  const dispatch = input.dispatch;
  try {
    const contract = resolveWorkflowContract(dispatch.snapshot.root, {
      requireState: true,
      branch: input.branch,
      workflow: input.workflow,
      stageId: input.stageId,
      maxInstructions: input.maxInstructions,
      policySnapshot: dispatch.snapshot,
      effectivePolicy: dispatch.effective_policy,
      catalog: dispatch.catalog,
      project_identity: dispatch.project_identity,
      run_identity: dispatch.run_identity,
      agentInventory: dispatch.agent_inventory,
    });
    return successResult(contract);
  } catch (error) {
    if (error instanceof WorkflowContractError) return failureResult(error.diagnostic);
    return failureResult(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "profile.resolve",
      remediation: "The admitted workflow contract could not be resolved from its exact project/run context.",
    }));
  }
}

/** Render a bounded contract or its typed fail-closed diagnostic. */
export function renderWorkflowCommandContract(input: FullstackWorkflowContractInput): string {
  const resolved = resolveWorkflowCommandContract(input);
  if (!resolved.ok) {
    const diagnostic = resolved.diagnostics[0];
    return `WORKFLOW_CONTRACT_ERROR ${diagnostic?.code ?? "MIGRATION_REQUIRED"}: ${diagnostic?.remediation ?? "workflow contract unavailable"}`;
  }
  return JSON.stringify(resolved.value);
}
