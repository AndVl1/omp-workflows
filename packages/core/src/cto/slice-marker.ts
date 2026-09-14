/** Shared CTO slice routing marker vocabulary. This module has no gate dependencies. */

/** Routing-marker prefix — a CTO slice task call carries `<!-- omp-cto-slice ... -->`. */
export const CTO_SLICE_MARKER_PREFIX = "<!-- omp-cto-slice";

/** Build the exact routing marker: `<!-- omp-cto-slice run=<runId> slice=<sliceId> -->`. */
export function buildCtoSliceMarker(runId: string, sliceId: string): string {
  return `${CTO_SLICE_MARKER_PREFIX} run=${runId} slice=${sliceId} -->`;
}
