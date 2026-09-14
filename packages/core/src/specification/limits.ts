/**
 * Shared byte ceilings for canonical readable specification documents and
 * anchored filesystem readers.
 *
 * Keep this module dependency-free so producers, readers, and materializers
 * can consume the same limits without introducing a cycle.
 */
export const MAX_PHASE_INPUT_BYTES = 1_000_000;

/** Maximum canonical UTF-8 bytes for a persisted CTO review packet. */
export const MAX_CTO_REVIEW_PACKET_BYTES = 1 * 1024 * 1024;

/** Maximum bytes accepted by the anchored regular-file reader and rollback snapshots. */
export const MAX_PINNED_ROOT_READ_BYTES = 8 * 1024 * 1024;
