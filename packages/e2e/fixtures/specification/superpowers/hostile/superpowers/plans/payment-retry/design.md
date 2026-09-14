# Design: Payment Retry With Backoff

- D-101: fixed in-process backoff schedule (1s/2s/4s).
- D-102: reuse the orders idempotency column; no new store.

Verification: unit tests on schedule boundaries; runtime scenarios for single
retry and dead-letter after exhaustion.
