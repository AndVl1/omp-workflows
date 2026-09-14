# Brief: Payment Retry With Backoff (v2 revision)

## Problem

Transient provider timeouts lose checkout sales because the first attempt is
never retried.

## Actors

Checkout service, payment provider client, orders repository.

## Outcome

Timed-out charges are retried with bounded backoff, never double-charging, and
exhausted retries land in a dead-letter store.
