import type { EscalationAdapter } from "@andvl1/omp-workflows-core";
import type { CtoRuntimeAccessFacade } from "@andvl1/omp-workflows-core/cto-runtime";
import { PinnedProjectRoot } from "../../core/src/specification/pinned-root.js";
import { bindEscalationAdapterRouting } from "../src/adapters/registry.js";

/**
 * Stamp a test adapter with the same root-bound routing proof used by the
 * production dispatcher. A temporary pin is closed after the binding marker
 * is published; callers that already own a session pin retain its lifetime.
 */
export function bindAuthenticatedAdapterRouting(
  root: string,
  adapter: EscalationAdapter,
  runtimeAccess: CtoRuntimeAccessFacade,
  pinnedRoot?: PinnedProjectRoot,
): boolean {
  const pin = pinnedRoot ?? PinnedProjectRoot.open(root);
  try {
    return bindEscalationAdapterRouting(adapter, runtimeAccess, pin);
  } finally {
    if (!pinnedRoot) pin.close();
  }
}
