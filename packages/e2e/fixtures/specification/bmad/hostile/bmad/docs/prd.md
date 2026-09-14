# PRD: Payment Retry

## Goals

- Retried charges never double-charge a customer.
- Every exhausted retry is visible in the dead-letter store.

## Functional Requirements

- FR-101: Retry a timed-out card charge up to 3 times with exponential backoff.
- FR-102: Reuse the provider idempotency key across attempts.
- FR-103: Write a dead-letter record after the final failed attempt.

## Success Criteria

- Zero duplicate charges in the provider sandbox across the retry suite.
- Dead-letter records exist for every exhausted order.
