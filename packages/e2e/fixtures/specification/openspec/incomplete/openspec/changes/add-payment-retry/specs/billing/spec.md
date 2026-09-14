## ADDED Requirements

### Requirement: Retry With Backoff

The system SHALL retry a timed-out charge up to 3 times with exponential backoff
against the `billing` baseline capability.

#### Scenario: single retry

- **WHEN** the first attempt times out
- **THEN** exactly one retry is issued with the same idempotency key

#### Scenario: retry budget exhausted

- **WHEN** three consecutive attempts time out
- **THEN** a dead-letter record is written and no further calls are made
