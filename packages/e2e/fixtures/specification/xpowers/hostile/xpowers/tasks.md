# Canonical Task Source: Payment Retry With Backoff

T-101 Implement RetryPolicy schedule | implements FR-101 | depends_on: none
T-102 Reuse idempotency keys across attempts | implements FR-102 | depends_on: T-101
T-103 Write dead-letter records after final failure | implements FR-103 | depends_on: T-102

This file is the only task source; task state elsewhere is not canonical.
