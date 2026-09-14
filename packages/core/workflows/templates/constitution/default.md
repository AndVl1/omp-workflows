
# Project Constitution

Version: {{VERSION}}

<!-- Framework-neutral bootstrap baseline: this template carries no external
     framework, CLI, or tooling dependency. The declared draft worker replaces
     every {{PLACEHOLDER}} with real governing content; the generated document
     must keep every omp-spec:marker section heading, resolve all placeholders,
     and number each principle as its own subsection with its own rationale.
     Unresolved {{...}} markers fail deterministic validation. -->

<!-- omp-spec:marker:principles -->
## Principles

{{PRINCIPLES}}

<!-- One numbered subsection per principle (### I. Name, ### II. Name, ...).
     Each principle states the binding rule in one or two sentences, then a
     `Rationale:` line giving the reason it governs this project. Principles
     are few, testable, and stable; prefer amending one principle over adding
     exceptions. -->

<!-- omp-spec:marker:rationale -->
## Rationale

{{RATIONALE}}

<!-- The governing intent behind the principle set: what the policy protects,
     what it deliberately leaves unregulated, how conflicts between principles
     are resolved, and the amendment rule (how a principle changes and which
     artifact versions the change makes stale). -->

<!-- omp-spec:marker:validation -->
## Validation

{{VALIDATION}}

<!-- The deterministic compliance checks every specification, plan, and task
     graph must pass against this constitution: one check per principle, each
     check observable in a review or test, with the evidence that proves it.
     These checks are evaluated as quality gates and can never be waived by a
     completion claim or human acknowledgement alone. -->
