import { existsSync, rmSync } from 'node:fs';

export interface ScratchLifecycleOutcome {
  readonly preserveOnFailure: boolean;
  /**
   * Test-only opt-in for retaining successful scratch evidence. When omitted,
   * `OMP_UX_E2E_PRESERVE_ON_SUCCESS=1` (or another accepted truthy value)
   * enables it for evidence collection; success is still removed by default.
   */
  readonly preserveOnSuccess?: boolean;
  readonly testFailed: boolean;
  readonly lifecycleFailed: boolean;
}

/**
 * Keep failed-run evidence only when failure was observed by the test or by
 * its final session lifecycle checks. Successful evidence is removed by
 * default, with an explicit test-only environment opt-in for preservation.
 */
export function finalizeScratchDirectory(
  scratchParent: string,
  outcome: ScratchLifecycleOutcome,
): 'preserved' | 'removed' {
  const failed = outcome.testFailed || outcome.lifecycleFailed;
  const preserveOnSuccess = outcome.preserveOnSuccess
    ?? /^(?:1|true|yes)$/iu.test(process.env["OMP_UX_E2E_PRESERVE_ON_SUCCESS"] ?? "");
  if ((outcome.preserveOnFailure && failed) || (!failed && preserveOnSuccess)) {
    // Emit the path before any later assertion or cleanup can obscure it.
    console.error(`ux-e2e: preserving scratch evidence at ${scratchParent}`);
    if (!existsSync(scratchParent)) {
      throw new Error(`ux-e2e: preserved scratch evidence is missing at ${scratchParent}`);
    }
    return 'preserved';
  }
  rmSync(scratchParent, { recursive: true, force: true });
  return 'removed';
}
