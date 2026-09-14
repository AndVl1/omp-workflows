# Brief: Payment Retry With Backoff (monolith legacy)

## Problem

Transient provider timeouts lose checkout sales because the first attempt is
never retried.

## Actors

Checkout service, payment provider client, orders repository.

## Outcome

Timed-out charges are retried with bounded backoff, never double-charging, and
exhausted retries land in a dead-letter store.

---

# Tasks: Payment Retry With Backoff

- [ ] T-101 Implement RetryPolicy schedule (FR-101)
- [ ] T-102 Reuse idempotency keys across attempts (FR-102, depends T-101)
- [ ] T-103 Write dead-letter records after final failure (FR-103, depends T-102)

Each task records expected outcome, affected scope, and verification evidence in
the phase packet.
