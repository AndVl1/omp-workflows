# Plan: Payment Retry With Backoff

## Repository Grounding

The checkout service lives in `src/checkout/`; the payment client is
`src/payments/charge-client.ts`; the orders repository already carries an
idempotency column.

## Decisions

### D-101. Deterministic in-process backoff

Use a fixed in-process backoff schedule (1s, 2s, 4s) instead of a scheduler
service. Rationale: retries are bounded and short-lived.

Alternatives considered: provider-side automatic retries (rejected: no client
control over attempt count), message-queue redelivery (rejected: ordering
guarantees complicate idempotency).

### D-102. Reuse the orders idempotency column

No new store; the existing column holds the provider idempotency key.

### D-103. Persist final retry exhaustion in the dead-letter audit

Reuse the existing dead-letter/audit failure persistence when retries are
finally exhausted, retaining the order id, attempt count, and provider error
code. This explicitly traces to FR-103.

## Data and Control Flow

Checkout service -> RetryPolicy -> PaymentProviderClient -> OrdersRepository.
The dead-letter writer subscribes to the retry-exhausted event.

## Contracts

RetryPolicy exposes `execute(charge): RetryResult`; RetryResult carries the
attempt count and the final provider outcome.

## Compatibility and Migration

No schema migration; the idempotency column already exists.

## Security and Operations

Idempotency keys are server-generated UUIDs; provider error codes are logged
without raw payloads. Dead-letter records are retained for 30 days.

## Verification Strategy

- Unit tests cover the backoff schedule boundaries (0 to 4 attempts).
- Runtime scenario A-101 proves one retried call with the same idempotency key.
- Runtime scenario A-102 proves the dead-letter record after the third timeout.

## Post-Design Constitution Check

D-101, D-102, and D-103 comply with P1 (approved contract unchanged) and P3
(evidence obligations are declared per task). D-103 explicitly covers the
FR-103 dead-letter outcome.
