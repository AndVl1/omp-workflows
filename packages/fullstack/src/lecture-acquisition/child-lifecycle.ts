import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

/**
 * Keep termination bounded without making a successful child pay the escalation cost.
 * The timer is unref'ed so a stuck child cannot keep the host process alive by itself.
 */
export const CHILD_TERMINATION_GRACE_MS = 250;

export interface ChildTerminationOwner {
  requestTermination(): void;
  dispose(): void;
}

/**
 * Owns the complete termination lifecycle for one child process.
 *
 * Callers may request termination from as many competing failure/timeout paths as
 * necessary; exactly one SIGTERM and, if the child stays open, one SIGKILL are
 * issued. The owner observes close/error so its timer and listeners never outlive
 * the child or the caller's terminal path.
 */
export function createChildTerminationOwner(
  child: ChildProcess,
  graceMs = CHILD_TERMINATION_GRACE_MS,
): ChildTerminationOwner {
  let closed = false;
  let disposed = false;
  let requested = false;
  let escalated = false;
  let escalationTimer: NodeJS.Timeout | undefined;

  const clearEscalationTimer = (): void => {
    if (!escalationTimer) return;
    clearTimeout(escalationTimer);
    escalationTimer = undefined;
  };

  const cleanup = (): void => {
    clearEscalationTimer();
    child.removeListener("close", onClose);
    child.removeListener("error", onError);
  };

  const onClose = (): void => {
    closed = true;
    cleanup();
  };
  const onError = (): void => {
    closed = true;
    cleanup();
  };

  child.once("close", onClose);
  child.once("error", onError);

  return {
    requestTermination(): void {
      if (disposed || closed || requested) return;
      requested = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The wait owner still observes the child close/error and preserves its
        // original typed cause; a failed kill must not replace that cause.
      }
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        if (disposed || closed || escalated) return;
        escalated = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // The close waiter remains authoritative for the terminal error.
        }
      }, Math.max(0, graceMs));
      escalationTimer.unref?.();
    },
    dispose(): void {
      disposed = true;
      cleanup();
    },
  };
}

export interface ChildDrainErrors {
  onError: () => Error;
  onClose: () => Error;
  onAbort: () => Error;
}

/**
 * Wait for one false-write drain without accumulating listeners across writes.
 * A persistent stdin error owner belongs to the surrounding feed operation; this
 * helper owns only the transient drain/error/close/abort listeners for one wait.
 */
export function waitForChildDrain(
  stream: Writable,
  signal: AbortSignal,
  errors: ChildDrainErrors,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };

    const onDrain = (): void => finish();
    const onError = (): void => finish(errors.onError());
    const onClose = (): void => finish(errors.onClose());
    const onAbort = (): void => finish(errors.onAbort());

    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
