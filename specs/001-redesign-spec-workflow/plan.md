# Implementation Plan: Readable Specification Workflow

**Branch**: `001-redesign-spec-workflow` | **Date**: 2026-08-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-redesign-spec-workflow/spec.md`

## Summary

Replace the JSON-only `spec-preparation` experience with one branch-independent feature workspace whose current state, validation, approvals, and next action are readable in Markdown. Specify, Plan, and Tasks content is always produced by capability-bound subagents, including when `/do-work` enters the full specification path. The engine persists the workers' typed artifacts, materializes versioned documents deterministically, completes validation, and only then presents a synchronous hard-human checkpoint. Direct phase commands, `/do-work`, CTO mode, legacy migration, and read-only external imports all reuse the existing durable workflow engine and one executor-neutral implementation handoff.

## Technical Context

**Language/Version**: TypeScript 5.6+, ESM, Node.js 20+

**Primary Dependencies**: Existing `@andvl1/omp-workflows-core` state/capability/checkpoint/artifact engine, `@oh-my-pi/pi-coding-agent` runtime contract, Node.js `fs`/`path`/`crypto`; no new runtime dependency is required

**Storage**: Human-readable Markdown under `specs/<feature-id>/`; canonical machine state, versioned typed artifacts, answer proofs, and execution claims under `.work-state/features/<feature-id>/`

**Testing**: `node:test` through `tsx` for core/fullstack/internal packages; deterministic child-process tests and the real OMP PTY harness in `packages/e2e`

**Target Platform**: Local OMP plugin runtime on Node.js 20+ across authorized project worktrees

**Project Type**: TypeScript monorepo containing reusable core, default fullstack bundle, private monorepo bundle, and E2E harness

**Performance Goals**: Idempotent replay with no duplicate phase versions or dispatches; content-addressed staleness checks proportional to the selected artifact set; no network access during native generation or local external intake; concurrency bounded by existing roster and CTO team caps

**Constraints**: One domain-agnostic engine and one workflow owner; branch-independent feature identity; phase content authored only by subagents; deterministic engine materialization is permitted but main-session authorship is not; validation finishes before the checkpoint; no detached/asynchronous review; exact three-decision human checkpoints; external sources remain read-only and are treated as untrusted data; fail closed on ambiguity, stale artifacts, path escape, owner conflict, or missing approval

**Scale/Scope**: 72 functional requirements and 18 measurable outcomes across native generation, direct and nested `/do-work`, read-only imports, CTO consumption/preparation, language/templates, and legacy migration; one repository with multiple feature workspaces and up to the existing CTO cap of eight teams per wave

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

### Pre-Design Gate

| Principle | Status | Plan obligation |
| --- | --- | --- |
| I. Domain-Agnostic Core | PASS | Core gains only reusable workspace, artifact, checkpoint, materialization, readiness, and claim contracts. Framework-specific recognizers and bundle defaults register through public seams. |
| II. Single Owner and Fail-Closed Boundaries | PASS | Existing owner claims remain authoritative. Every feature, capability, handoff, and execution claim is explicitly bound; ambiguity or conflict performs no mutation. |
| III. Contract-First Compatibility | PASS | Persisted schemas, public tool/command behavior, producers, consumers, tests, docs, and migration receipts change together. No compatibility shim becomes a second implementation. |
| IV. Deterministic State and Durable Dispatch | PASS | Existing capability epochs, trusted answer ledger, atomic writes, profile hashes, and idempotent completion remain the only transition path. Markdown is a deterministic projection of typed worker results. |
| V. Runtime-Backed Verification | PASS | Each slice requires affected package tests plus real command/process coverage for checkpoints, resume, stale input, claims, imports, and CTO dispatch. |
| Package and Runtime Constraints | PASS | ESM TypeScript and Node.js 20+ remain unchanged; no deep-import API or new runtime dependency is introduced. |

No constitutional exception is required.

### Post-Design Re-check

PASS. The design extends `TeamState`, `StageDef` document rendering, artifact schemas, checkpoint policy, and workflow contracts additively, then performs a clean profile/command cutover. Direct commands, `/do-work`, and CTO mode consume the same workspace and handoff; external format adapters cannot bypass generic conformance; human approval remains proof-bound and synchronous. The proposed explicit feature selector removes the branch-derived active-pointer authority rather than adding another state store.

## Project Structure

### Documentation (this feature)

```text
specs/001-redesign-spec-workflow/
├── plan.md                         # This Phase 1 implementation plan
├── research.md                     # Phase 0 decisions and source evidence
├── data-model.md                   # Persisted entities and transitions
├── quickstart.md                   # Runnable validation guide
├── contracts/
│   ├── command-contract.md
│   ├── feature-workspace.schema.json
│   └── implementation-handoff.schema.json
└── tasks.md                        # Created later by the Tasks phase, not by this command
```

The runtime workspace produced by the implemented feature is:

```text
specs/<feature-id>/
├── status.md                       # Phase, approvals, validation, next action
├── spec.md
├── plan.md
├── research.md                     # Optional Plan auxiliary
├── data-model.md                   # Optional Plan auxiliary
├── contracts/                      # Optional Plan interfaces
├── quickstart.md                   # Optional Plan validation guide
├── tasks.md
├── validation/
│   ├── specify.md
│   ├── plan.md
│   └── tasks.md
├── history/                        # Prior readable revisions, written on replacement
└── handoff.md                      # Readable projection of the frozen handoff

.work-state/features/<feature-id>/
├── state.json                      # Canonical state and current version pointers
└── artifacts/                      # Immutable versioned typed worker results
```

### Source Code (repository root)

```text
packages/core/
├── src/
│   ├── engine/
│   │   ├── state.ts                # Explicit feature identity, migration, stale propagation
│   │   ├── types.ts                # Additive persisted/public contracts
│   │   ├── durable.ts              # Capability-bound materialization and advancement
│   │   ├── checkpoints.ts          # Three decisions and proof binding
│   │   ├── artifacts.ts            # Immutable versioned artifact ids
│   │   └── workflow-contract.ts    # Workspace readiness projection
│   ├── specification/              # One cohesive reusable specification subsystem
│   │   ├── workspace.ts
│   │   ├── materialize.ts
│   │   ├── templates.ts
│   │   ├── validation.ts
│   │   ├── handoff.ts
│   │   ├── claims.ts
│   │   └── import.ts
│   └── commands/
│       ├── register.ts
│       ├── do-work.ts
│       └── cto.ts
├── workflows/
│   ├── spec-preparation.json       # Cleanly replaced native phase profile
│   ├── spec-import.json            # Read-only intake profile, same handoff
│   ├── artifacts-schema.json
│   ├── _schema.json
│   ├── templates/specification/
│   └── stages/
└── test/                            # Contract, state, renderer, command, and CTO tests

packages/fullstack/
├── src/
│   ├── workflow-commands.ts
│   ├── index.ts
│   └── specification/recognizers/  # Spec Kit/OpenSpec/BMAD/Superpowers/XPowers adapters
└── test/

packages/omp-workflows-internal/     # Namespaced command/profile integration tests
packages/e2e/
├── scenarios/                       # Real OMP phase/checkpoint/import/CTO scenarios
├── src/
└── test/                            # Deterministic process-boundary coverage
```

**Structure Decision**: Keep canonical workflow state in the existing engine and add a focused `specification` subsystem for reusable aggregate logic. Profiles remain declarative JSON. The core exposes generic recognizer/template registration and generic conformance; named framework recognizers live in the fullstack bundle. `.active-feature` becomes a convenience pointer only—every new tool transition resolves an explicit `feature_id`/`run_key` and remains capability-bound.

## Design

### Phase Pipeline

Each native phase uses the same blocking sequence:

1. A `single` or `consilium` stage dispatches the declared analyst/architect/research workers and returns schema-validated typed artifacts. The main session does not draft or repair their content.
2. The engine persists an immutable phase version, resolves the selected language and template, and atomically materializes Markdown through a registered document renderer.
3. Deterministic validation checks mandatory semantic section markers, unresolved clarifications, contradictions, constitution compliance, traceability, upstream version bindings, safe paths, and implementation readiness. The phase worker's semantic findings are stored alongside deterministic findings; there is no detached reviewer.
4. Only a passing validation result opens a hard-human checkpoint with exactly `approve_continue`, `request_changes`, or `approve_stop`.
5. `request_changes` records feedback and reopens the affected content stage through the existing continuation path; a new capability epoch and artifact version are required. `approve_stop` records approval, advances to the next pending phase, and returns without dispatching it. `approve_continue` advances and dispatches the next phase in the same turn.

Specify, Plan, and Tasks are independently invocable through `/specify`, `/spec-plan`, and `/spec-tasks`, while approve-and-continue remains an explicit convenience. A full specification nested from `/do-work` invokes the same profile stages and subagents; the parent intent changes only what happens after the Tasks checkpoint.

### Identity, Versions, and Staleness

- A feature receives an immutable, branch-independent `feature_id`; the readable directory is `specs/<feature-id>/`.
- New workflow tools carry an explicit feature/run selector. The capability's `issued_for.run_key`, cursor epoch, profile hash, and dispatch marker remain authoritative; an active pointer cannot redirect an in-flight call.
- Every phase version binds the worker dispatch, template hash, language, document hash, validation result, and exact upstream versions.
- Any manual edit or changed upstream semantic hash marks the phase and dependent approvals stale. Presentation-only changes remain current only when a deterministic validation record proves unchanged semantic section hashes; otherwise the safe default is stale.
- Current Markdown is readable state; prior replaced revisions move to `history/`. Machine artifacts are immutable rather than overwritten.

### Templates and Language

Template resolution order is feature override, project/workflow-owner default, then shipped baseline. Language resolution order is feature override, project default, then initiating-request language. Templates use stable semantic section markers independent of localized headings; a project override that omits mandatory markers fails before generation. Template and language changes create a new artifact version and stale every affected approval.

### Handoff and Execution Claim

One versioned implementation handoff contains approved scope, requirement/decision/task/verification traceability, validation and constitution status, risks, language, source provenance, and exact bound phase versions. `/do-work` and CTO preflight call one readiness predicate over this contract. A durable execution claim is keyed by handoff digest and permits one active owner (`do-work` run or CTO wave); conflicts fail closed or queue. Claims never grant approval and cannot survive a changed handoff.

### External Intake

`/spec-import <authorized-local-path>` resolves candidate files read-only, rejects escapes/symlinks/unsupported or oversized input, records source revision and SHA-256 fingerprints, redacts secrets, and treats embedded instructions as inert data. Fullstack recognizers may improve mapping for known frameworks, but core generic conformance remains available. The engine produces an immutable import snapshot, readable compatibility report, optional local supplement, and the same handoff schema used by native work. External completion or approval metadata is provenance only; source files are hash-checked before and after intake and never written.

### `/do-work` and CTO Integration

- `/do-work` first resolves an explicit or uniquely matching ready handoff. A ready handoff skips product/requirements/architecture rediscovery; a partial, stale, conflicting, or ambiguous workspace routes to the earliest affected phase and dispatches no implementation.
- Without a handoff, quick low-risk work retains the lightweight profile, medium work may run focused clarification or bounded Specify, and complex/critical/low-confidence/security/infrastructure work enters the full three-phase profile.
- CTO execution freezes selected handoff versions into the existing team plan, obtains the current user’s mapping confirmation, then parallelizes only dependency- and ownership-safe slices.
- CTO preparation delegates each feature to the standard specification profile. Independent feature workspaces may run in parallel when their explicit run identities and write scopes do not overlap; facets of one feature serialize behind one phase writer. CTO renders one review packet but records a separate synchronous checkpoint decision in each feature state. Final Tasks approval ends preparation; implementation requires a separate explicit CTO execution wave.

## Implementation Sequence

1. **Addressable workspace foundation** — add branch-independent feature identity, explicit run selection, additive state migration, immutable version pointers, safe paths, and typed artifact schemas.
2. **Phase materialization and gates** — add generic registered renderers/templates, versioned Markdown/history/status projections, validation records, semantic staleness propagation, and the exact three-decision checkpoint behavior.
3. **Shared handoff and claim** — define the executor-neutral handoff, one readiness predicate, conflict routing, and an exclusive handoff-version execution claim before integrating any entry point.
4. **First vertical slice: external intake → `/do-work`** — implement generic read-only import, one Spec Kit fixture adapter, compatibility checkpoint, and single-spec `/do-work` execution. This delivers the preferred interoperability slice while exercising the shared handoff early.
5. **Native explicit phases** — replace `spec-preparation.json` with delegated Specify/Plan/Tasks stages, deterministic materialization, synchronous checkpoints, baseline templates, language precedence, and direct phase commands.
6. **Adaptive `/do-work` preparation** — consume ready native handoffs, add quick/medium/full routing, and make the full nested path call the same subagent stages without main-session authorship.
7. **CTO handoff execution** — add multi-workspace preflight, frozen specification-to-team mapping, per-version claims, dependency-safe parallelization, and mapping confirmation.
8. **CTO specification preparation** — add bounded standard-profile slices, per-feature synchronous checkpoint fan-in, mixed-decision handling, queue reasons, and the hard stop before implementation.
9. **Remaining compatibility and migration** — add OpenSpec/BMAD/Superpowers/XPowers recognizers, generic hostile/unknown fixtures, legacy JSON materialization with fresh approval, and final cross-profile migration removal.

Tests, runtime scenarios, consumer documentation, and changelog entries land with the slice whose observable contract they protect; they are not deferred to a cleanup-only final phase.

## Complexity Tracking

No constitution violation is accepted. The new `specification` directory is a cohesive reusable subsystem inside the existing core, not a second engine. The separate `spec-import` profile is a declarative entry path that terminates in the same workspace, checkpoint authority, readiness predicate, and handoff.
