import { AsyncLocalStorage } from "node:async_hooks";

/** A synchronous assertion that the authenticated host execution is still live. */
export type ExecutionLivenessGuard = () => void;

/** Error raised when a guarded execution loses its authenticated live context. */
export class ExecutionLivenessViolation extends Error {
  readonly code = "execution_liveness_lost" as const;

  constructor(message: string) {
    super(message);
    this.name = "ExecutionLivenessViolation";
  }
}

const executionLiveness = new AsyncLocalStorage<ExecutionLivenessGuard | null>();

/** Run one host operation with an async-local liveness assertion. */
export function withExecutionLiveness<T>(guard: ExecutionLivenessGuard, operation: () => T): T {
  return executionLiveness.run(guard, operation);
}

/** Run identity-checked compensation without the authority guard. */
export function withoutCurrentExecutionLiveness<T>(operation: () => T): T {
  return executionLiveness.run(null, operation);
}

/** Assert the current host execution before a durable side effect. */
export function assertCurrentExecutionLiveness(): void {
  const guard = executionLiveness.getStore();
  if (guard !== undefined && guard !== null) guard();
}
