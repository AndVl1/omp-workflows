# Requirements: Payment Retry With Backoff

Status: approved (immutable)

The requirement set below is approved and immutable during execution for payment retry.

## FR-101

Retry a timed-out card charge up to 3 times with exponential backoff (1s, 2s, 4s).

## FR-102

Every retried charge reuses the provider idempotency key of the first attempt.

## FR-103

After the final failed attempt, a dead-letter record captures order id, attempt
count, and provider error code.
