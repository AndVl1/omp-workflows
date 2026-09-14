# Project Constitution

## 1. Correctness and Explicit Contracts
All specifications and implementation handoffs must define observable behavior, inputs, outputs, failure modes, and invariants. Rationale: explicit contracts prevent ambiguity and make verification repeatable.

## 2. Maintainable Simplicity
Prefer the smallest coherent design that follows existing project conventions; avoid duplicate abstractions, speculative extensibility, and compatibility shims without a stated requirement. Rationale: simple, conventional systems remain understandable and safe to change.

## 3. Evidence-Based Quality
Every material behavior change must have proportionate verification evidence, with tests reserved for durable contracts and realistic regressions. Rationale: executable evidence catches defects while keeping the test suite purposeful.

## 4. Security and Data Integrity
Specifications must identify trust boundaries, sensitive data, authorization requirements, transactional invariants, and safe failure behavior wherever applicable. Rationale: security and integrity must be designed in rather than recovered after implementation.

## 5. Clean Ownership and Traceability
Each feature, facet, artifact, checkpoint, and handoff must have one explicit owner and durable provenance; shared facets remain within one feature workspace. Rationale: unambiguous ownership prevents divergent state and preserves an auditable decision trail.

## 6. Human Authorization at Declared Gates
Required checkpoints may advance only from a trusted typed user decision; workflow classification, autonomy hints, artifacts, or inferred intent never substitute for approval. Rationale: explicit authorization preserves user control over consequential transitions.

## 7. Preparation and Execution Separation
Specification preparation ends with approved implementation-ready handoffs and must not dispatch implementation work unless a separate execution request is made. Rationale: separating design approval from execution prevents accidental scope escalation.