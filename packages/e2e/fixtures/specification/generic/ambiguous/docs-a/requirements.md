# Requirements: Payment Retry With Backoff (docs-a)

## Problem

Checkout fails when the payment provider returns transient 5xx responses. Customers

## Actors

- Checkout service
- Payment provider client
- Orders repository

## Scope

- In-scope: automatic retry of timed-out card charges, idempotency keys, dead-letter
  recording after the final attempt.
- Out-of-scope: alternative payment providers, subscription billing, refunds.

## Requirements

### FR-101

The system MUST retry a timed-out card charge up to 3 times with exponential backoff
(1s, 2s, 4s) before giving up.

### FR-102

Every retried charge MUST reuse the same provider idempotency key as the first attempt.

### FR-103

After the final failed attempt the system MUST write a dead-letter record with the
order id, attempt count, and provider error code.

## Acceptance Scenarios

### A-101 (observable)

Given a provider timeout on the first attempt, when the charge is retried, then
exactly one additional provider call is made within 2 seconds using the same
idempotency key.

### A-102 (observable)

Given three consecutive timeouts, when the retry budget is exhausted, then a
dead-letter record for the order exists and no further provider calls are made.

### A-103

Given a successful retry, when the order is inspected, then the audit log shows the
attempt number that succeeded.

## Edge Cases

- Provider succeeds after the retry budget emitted a dead-letter record.
- Idempotency key collision between two concurrent checkouts.

## Assumptions

- The provider idempotency window is at least 10 minutes.
- Dead-letter storage is eventually consistent.

## Success Criteria

- Retried charges never double-charge the customer.
- Every exhausted retry is visible in the dead-letter store.
