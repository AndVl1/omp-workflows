import { resolveWorkflowContract, WorkflowContractError, type WorkflowContract } from "@andvl1/omp-workflows-core";

/** Structured command/runtime surface for consumers that need current workflow data. */
export function resolveWorkflowCommandContract(cwd: string, options: Parameters<typeof resolveWorkflowContract>[1] = {}): WorkflowContract {
  return resolveWorkflowContract(cwd, options);
}

/** Bounded, prompt-safe rendering; errors are explicit and never fall back to plugin scanning. */
export function renderWorkflowCommandContract(cwd: string, options: Parameters<typeof resolveWorkflowContract>[1] = {}): string {
  try {
    return JSON.stringify(resolveWorkflowCommandContract(cwd, options));
  } catch (error) {
    if (error instanceof WorkflowContractError) return `WORKFLOW_CONTRACT_ERROR ${error.code}: ${error.message}`;
    return "WORKFLOW_CONTRACT_ERROR STATE_UNREADABLE: workflow contract unavailable";
  }
}
