# Story 1.1: Legacy Checkout Retry

## Story

As a checkout customer, I want transient payment failures retried automatically,
so my purchase is not lost to a provider hiccup.

## Acceptance Criteria

- AC1: A timed-out charge is retried within 2 seconds using the same idempotency
  key. (FR-101, FR-102)
- AC2: After three timeouts a dead-letter record exists and no further calls are
  made. (FR-103)

## Tasks / Dev Notes

- [x] Implement the retry schedule (legacy v4 flat layout)
- [x] Reuse the idempotency key across attempts
- [ ] Add dead-letter persistence
