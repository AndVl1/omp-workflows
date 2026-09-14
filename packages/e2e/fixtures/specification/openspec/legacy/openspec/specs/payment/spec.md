# Payment Capability

## Purpose

Covers card charge authorization and capture for checkout.

## Requirements

### Requirement: Card charge

The system SHALL authorize a card charge through the configured provider before
order confirmation.

#### Scenario: successful charge

- **WHEN** the provider authorizes the charge
- **THEN** the order moves to the confirmed state
