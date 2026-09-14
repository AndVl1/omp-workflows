<!--
Sync Impact Report
- Version change: unversioned scaffold -> 1.0.0
- Modified principles:
  - Placeholder Principle 1 -> I. Domain-Agnostic Core
  - Placeholder Principle 2 -> II. Single Owner and Fail-Closed Boundaries
  - Placeholder Principle 3 -> III. Contract-First Compatibility
  - Placeholder Principle 4 -> IV. Deterministic State and Durable Dispatch
  - Placeholder Principle 5 -> V. Runtime-Backed Verification
- Added sections:
  - Package and Runtime Constraints
  - Development Workflow and Quality Gates
- Removed sections: None; both placeholder sections were concretized.
- Follow-up TODOs: None.
-->
# OMP Workflows Constitution

## Core Principles

### I. Domain-Agnostic Core

`@andvl1/omp-workflows-core` MUST contain only reusable workflow-engine capabilities:
state transitions, gates, command contracts, configuration loading, artifact schemas, and public
extension seams. It MUST NOT contain bundle-specific agents, skills, role assignments, stack
opinions, or private-monorepo activation rules. Public and private bundles MUST compose core
through its exported contracts instead of copying or bypassing engine logic.

Rationale: a neutral core lets consumers build independent bundles without inheriting the
fullstack team's policy or creating incompatible workflow engines.

### II. Single Owner and Fail-Closed Boundaries

Each canonical worktree MUST have exactly one authorized owner for
`workflow_registration`, `workflow_tools`, and `config_writer`. Command registration MUST NOT be
treated as workflow ownership. Owner conflicts, unresolved or unauthorized working directories,
missing activation markers, stale capabilities, and invalid stage transitions MUST fail closed
without mutating workflow state or configuration. Bundles that coexist MUST use distinct command
prefixes and MUST NOT rely on extension load order to select an owner.

Rationale: deterministic ownership prevents one command surface from dispatching through another
bundle's state machine or configuration writer.

### III. Contract-First Compatibility

Changes to exported APIs, workflow profiles, schemas, artifacts, command behavior, configuration,
or package boundaries MUST update every producer, consumer, test, and user-facing document in the
same change. Registered extension commands are authoritative; disk-discovered compatibility
commands MUST remain thin adapters generated or synchronized from the same implementation.
Compatibility paths MUST have an explicit supported-runtime purpose and tests; they MUST NOT
become a second implementation. Breaking contract changes require a semantic-version bump and a
documented migration path.

Rationale: consumers depend on behavior across package, command, and persisted-artifact boundaries,
so partial migrations create failures that compilation alone cannot detect.

### IV. Deterministic State and Durable Dispatch

Workflow stage transitions, dispatch completion, checkpoint decisions, capability issuance, and
configuration writes MUST be explicit, validated, and idempotent. Resumption MUST use persisted
state as the source of truth rather than prompt history. Replayed completion or initialization
calls MUST either return the established result or reject without duplicate side effects. Command
handlers MUST route work through OMP's normal user-message and hook lifecycle. Generated project
configuration MAY be seeded only when absent and MUST NOT overwrite user-managed configuration.

Rationale: workflows cross agent, process, and session boundaries; durable and replay-safe state is
required for correct recovery.

### V. Runtime-Backed Verification

Every permanent behavior change MUST pass type checking and the affected package's behavioral
tests. Changes to ownership, commands, gates, state transitions, persistence, or schemas MUST cover
both the successful path and relevant fail-closed paths. Runtime-facing command or extension
changes MUST also be exercised through the real OMP runtime or the repository's executable E2E
harness. Tests MUST assert observable contracts and MUST fail for a plausible regression; source
text assertions, no-op mocks, and symptom suppression are not acceptable evidence.

Rationale: this project integrates with a host runtime whose registration, lifecycle, and
persistence behavior cannot be proven by isolated unit tests alone.

## Package and Runtime Constraints

- The workspace MUST remain ESM TypeScript targeting Node.js 20 or newer.
- `packages/core` owns the generic public engine. `packages/fullstack` owns the public default
  agents, skills, and command bundle. The internal package MUST remain private and physically
  marker-gated to this monorepo. The E2E package MUST exercise installed/runtime behavior rather
  than duplicate production logic.
- Public fullstack releases MUST declare a compatible core peer dependency, and packages released
  together MUST remain on the same minor version line unless a documented compatibility matrix
  proves otherwise.
- Public entry points MUST be declared through package exports. Internal modules MUST NOT become
  de facto APIs through undocumented deep imports.
- External inputs, project roots, persisted artifacts, and configuration MUST be validated before
  use. Missing authorization or malformed data MUST produce a diagnostic and no state mutation.
- Schema or artifact evolution MUST preserve deterministic parsing and include an explicit
  migration or a justified breaking-version change.

## Development Workflow and Quality Gates

1. Before editing an exported symbol or persisted contract, the implementer MUST identify the
   current implementation, all call sites, affected packages, and the observable behavior being
   changed.
2. Implementation MUST use the existing architectural seam. A new parallel convention requires a
   documented reason and maintainer approval. Clean cutovers MUST remove obsolete callers, aliases,
   comments, and dead compatibility code unless that compatibility path is explicitly supported.
3. The affected package tests and type checks MUST pass. Packaging or export changes MUST also pass
   the affected builds. Runtime-facing changes MUST pass the relevant smoke or E2E scenario.
4. Public behavior, configuration, compatibility, or release changes MUST update README, package
   documentation, and CHANGELOG entries where consumers need the information.
5. Reviewers MUST verify compliance with all five Core Principles. Any approved exception MUST name
   the violated rule, justify why no compliant solution is viable, define its scope, and include a
   removal condition.

## Governance

This constitution is the highest project-level engineering policy. Repository guidance, workflow
profiles, specifications, and implementation plans MUST conform to it; conflicts MUST be resolved
in favor of this document unless a higher-level platform or security policy is stricter.

Amendments require a reviewed change to this file that states the rationale, migration impact, and
Sync Impact Report. Maintainer approval is required before merge. The constitution version follows
semantic versioning: MAJOR for incompatible removals or redefinitions of governance, MINOR for new
principles or materially expanded obligations, and PATCH for non-semantic clarification. The
original ratification date MUST remain unchanged; the last-amended date MUST change whenever the
constitution changes.

Every feature specification, implementation plan, and code review MUST include a constitution
compliance check. Releases MUST NOT proceed while a known violation is unresolved or while an
exception lacks the bounded justification required by the Development Workflow section.

**Version**: 1.0.0 | **Ratified**: 2026-08-30 | **Last Amended**: 2026-08-30
