# Decisions: Payment Retry With Backoff

## D-101. Deterministic in-process backoff

Fixed 1s/2s/4s schedule; no scheduler service. Traces to FR-101.

## D-102. Reuse the orders idempotency column

The existing column stores the provider idempotency key. Traces to FR-102.

## D-103. Persist final retry exhaustion in the dead-letter audit

Reuse the existing dead-letter/audit failure persistence when retries are
finally exhausted, including the order id, attempt count, and provider error
code. Traces to FR-103.
