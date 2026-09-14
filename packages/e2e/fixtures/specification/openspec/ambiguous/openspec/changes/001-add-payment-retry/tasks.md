# Tasks: 001-add-payment-retry

## 1. Implementation

- [ ] 1.1 Add the retry schedule to the payment client (FR-101)
- [ ] 1.2 Reuse the idempotency key across attempts (FR-102)
- [ ] 1.3 Write dead-letter records after the final failure (FR-103)

## 2. Validation

- [ ] 2.1 Runtime scenario proves single retry with the same key
