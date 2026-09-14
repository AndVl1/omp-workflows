# Tasks: Payment Retry With Backoff

## T-101. Implement RetryPolicy schedule

Implements FR-101. Depends on: none.

- Expected outcome: retries use the fixed 1s/2s/4s schedule and stop after the
  third failed attempt.
- Affected scope: `src/payments/retry-policy.ts`.
- Verification evidence: unit test covering attempt boundaries.

## T-102. Reuse idempotency keys across attempts

Implements FR-102. Depends on: T-101.

- Expected outcome: every attempt of one charge sends the identical provider
  idempotency key.
- Affected scope: `src/payments/charge-client.ts`.
- Verification evidence: runtime scenario A-101.

## T-103. Write dead-letter records after final failure

Implements FR-103. Depends on: T-102.

- Expected outcome: a dead-letter record with order id, attempt count, and
  provider error code exists after the final failed attempt.
- Affected scope: `src/payments/dead-letter.ts`.
- Verification evidence: runtime scenario A-102.
