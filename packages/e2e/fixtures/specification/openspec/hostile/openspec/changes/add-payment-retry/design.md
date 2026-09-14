# Design: Add Payment Retry With Backoff

Backoff is a deterministic in-process schedule (1s/2s/4s). The idempotency key is
generated once per charge and reused for every attempt. Dead-letter writes are
idempotent per order id.
