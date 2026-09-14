/**
 * Runtime bounds shared by native specification E2E helpers.
 *
 * Each specification phase keeps the declared 600-second product deadline.
 * The bounded receipt grace only covers PTY/transcript scheduling after the
 * engine deadline; it never changes the product SLA.
 */
export const SPECIFICATION_STAGE_DEADLINE_MS = 600_000;
export const SPECIFICATION_STAGE_RECEIPT_GRACE_MS = 30_000;
export const SPECIFICATION_STAGE_WAIT_TIMEOUT_MS =
  SPECIFICATION_STAGE_DEADLINE_MS + SPECIFICATION_STAGE_RECEIPT_GRACE_MS;
