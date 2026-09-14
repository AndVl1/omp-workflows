# Architecture: Payment Retry

## Components

- RetryPolicy: owns the 1s/2s/4s schedule.
- ChargeClient: provider calls; carries the idempotency key.
- DeadLetterWriter: persists exhausted retries.

## Data Flow

Checkout -> RetryPolicy -> ChargeClient -> OrdersRepository; RetryPolicy emits
retry-exhausted events consumed by DeadLetterWriter.
