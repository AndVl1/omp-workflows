# Proposal: Add Payment Retry (v2) With Backoff

## Why

Transient provider timeouts currently lose the sale because no retry exists.

## What Changes

- Add a bounded retry schedule to the payment capability.
- Reuse provider idempotency keys across attempts.
- Record dead-letter entries after the final failed attempt.

## Impact

Affected specs: `payment`. Affected code: `src/payments/`.
