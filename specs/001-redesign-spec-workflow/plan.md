# Implementation Plan: Readable Specification Workflow

**Branch**: `001-redesign-spec-workflow` | **Date**: 2026-08-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-redesign-spec-workflow/spec.md`

## Summary

Replace the JSON-only `spec-preparation` experience with one branch-independent feature workspace whose current state, validation, approvals, constitution binding, and next action are readable in Markdown. Before any native Specify generation or external compatibility validation, one shared prerequisite deterministically verifies the project constitution and, when unusable, blocks the origin behind the canonical constitution workflow's two-decision approval loop before resuming it exactly once. Specify, Plan, and Tasks content is always produced by capability-bound subagents, including when `/do-work` enters the full specification path. The engine persists typed artifacts, materializes versioned documents deterministically, completes validation, and only then presents synchronous hard-human checkpoints. Direct phase commands, `/do-work`, CTO mode, legacy migration, and read-only external imports all reuse the existing durable engine, exact constitution bindings with targeted semantic-impact staleness, and one executor-neutral implementation handoff.

## Technical Context

**Language/Version**: TypeScript 5.6+, ESM, Node.js 20+

**Primary Dependencies**: Existing `@andvl1/omp-workflows-core` state/capability/checkpoint/artifact engine, canonical Spec Kit constitution command plus shared template resolver contract, `@oh-my-pi/pi-coding-agent` runtime contract, Node.js `fs`/`path`/`crypto`; no new runtime dependency is required

**Storage**: Human-readable feature Markdown under `specs/<feature-id>/`; the canonical project policy at `.specify/memory/constitution.md`; canonical machine state, versioned typed artifacts, prerequisite continuations, constitution bindings/impact assessments, answer proofs, and execution claims in the existing `.work-state` engine storage

**Testing**: `node:test` through `tsx` for core/fullstack/internal packages; deterministic child-process tests and the real OMP PTY harness in `packages/e2e`

**Target Platform**: Local OMP plugin runtime on Node.js 20+ across authorized project worktrees

**Project Type**: TypeScript monorepo containing reusable core, default fullstack bundle, private monorepo bundle, and E2E harness

**Performance Goals**: Idempotent replay with no duplicate constitution drafts, origin resumes, phase versions, or dispatches; content-addressed staleness and constitution-impact checks proportional to the bound artifact set; no network access during native generation or local external intake; concurrency bounded by existing roster and CTO team caps

**Constraints**: One domain-agnostic engine and one workflow owner; one canonical constitution authoring/persistence workflow; branch-independent feature identity; no native Specify or external compatibility validation before a usable constitution; bootstrap has exactly `approve_continue`/`request_changes` and resumes the exact origin once; phase content authored only by subagents; deterministic engine materialization is permitted but main-session authorship is not; validation finishes before the checkpoint; no detached/asynchronous review; exact three-decision phase checkpoints; every validation/approval/compatibility decision/handoff binds the constitution version and content fingerprint; constitution changes stale only artifacts proven affected; external sources remain read-only and untrusted; fail closed on ambiguity, stale/unassessed impact, path escape, owner conflict, or missing approval

**Scale/Scope**: 78 functional requirements and 21 measurable outcomes across the shared constitution prerequisite and impact analysis, native generation, direct and nested `/do-work`, read-only imports, CTO consumption/preparation, language/templates, and legacy migration; one repository with multiple feature workspaces and up to the existing CTO cap of eight teams per wave

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

### Pre-Design Gate

| Principle | Status | Plan obligation |
| --- | --- | --- |
| I. Domain-Agnostic Core | PASS | Core gains only reusable prerequisite continuation, governance binding/impact, workspace, artifact, checkpoint, materialization, readiness, and claim contracts. Spec Kit command/template adapters and bundle defaults register through public seams. |
| II. Single Owner and Fail-Closed Boundaries | PASS | The canonical constitution workflow and existing owner claims remain authoritative. Every prerequisite origin, feature, capability, binding, handoff, and execution claim is explicit; unusable policy, ambiguous impact, or conflict performs no downstream mutation. |
| III. Contract-First Compatibility | PASS | Constitution command/adapters, persisted schemas, public tool behavior, producers, consumers, tests, docs, and migration receipts change together. Entry points call one prerequisite; no compatibility shim or intake path becomes a second constitution implementation. |
| IV. Deterministic State and Durable Dispatch | PASS | Existing capability epochs, trusted answer ledger, atomic writes, profile hashes, and idempotent completion remain the only transition path. Constitution usability, two-decision approval, exact-origin resume, and semantic-impact results are persisted typed records; Markdown remains a deterministic projection. |
| V. Runtime-Backed Verification | PASS | Each slice requires affected package tests plus real command/process coverage for constitution fixtures and resume, checkpoints, stale/no-impact policy changes, claims, imports, and CTO dispatch. |
| Package and Runtime Constraints | PASS | ESM TypeScript and Node.js 20+ remain unchanged; the canonical constitution/template integration reuses existing contracts and introduces no deep-import API or runtime dependency. |

No constitutional exception is required.

### Post-Design Re-check

PASS. The design extends `TeamState`, prerequisite continuation, `StageDef` document rendering, artifact schemas, checkpoint policy, and workflow contracts additively, then performs a clean profile/command cutover. One canonical constitution workflow owns document generation and persistence; every required entry point uses the same fail-closed usability gate and durable origin continuation. Exact content bindings plus typed, artifact-scoped impact evidence prevent both unsafe stale approvals and blanket formatting-only invalidation. Direct commands, `/do-work`, and CTO mode consume the same workspace and handoff; external format adapters cannot bypass the constitution gate or generic conformance; human approval remains proof-bound and synchronous. The explicit feature selector removes branch-derived active-pointer authority rather than adding another state store.

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
│   ├── tasks.md
│   └── constitution-impact.md      # Current binding/impact evidence when policy changed
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
│   │   ├── checkpoints.ts          # Phase/constitution decisions and trusted proof binding
│   │   ├── artifacts.ts            # Immutable versioned artifact ids
│   │   └── workflow-contract.ts    # Workspace readiness projection
│   ├── gates/
│   │   └── constitution.ts         # Pure usability check and fail-closed prerequisite gate
│   ├── specification/              # One cohesive reusable specification subsystem
│   │   ├── workspace.ts
│   │   ├── prerequisite.ts         # Durable origin descriptor and exactly-once continuation
│   │   ├── constitution-impact.ts   # Binding comparison and targeted stale/no-impact evidence
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
│   ├── constitution.json           # Canonical wrapper profile; existing command remains sole writer
│   ├── spec-preparation.json       # Cleanly replaced native phase profile
│   ├── spec-import.json            # Read-only intake profile, same handoff
│   ├── artifacts-schema.json
│   ├── _schema.json
│   ├── templates/specification/
│   └── stages/
└── test/                            # Contract, state, gate, renderer, command, and CTO tests

packages/fullstack/
├── src/
│   ├── workflow-commands.ts
│   ├── index.ts
│   └── specification/
│       ├── constitution-provider.ts # Registers existing Spec Kit command/template resolver contract
│       └── recognizers/             # Spec Kit/OpenSpec/BMAD/Superpowers/XPowers adapters
└── test/

packages/omp-workflows-internal/     # Namespaced command/profile integration tests
packages/e2e/
├── scenarios/                       # Real OMP phase/checkpoint/import/CTO scenarios
├── src/
└── test/                            # Deterministic process-boundary coverage
```

**Structure Decision**: Keep canonical workflow state in the existing engine and add a focused `specification` subsystem for reusable aggregate logic. The pure constitution usability check lives with existing core gates; durable origin continuation reuses `TeamState`, pause, capability, and checkpoint records. `constitution.json` wraps the registered canonical `.omp/commands/speckit.constitution.md` command as its sole content writer and adds deterministic validation plus engine-owned approval; it does not copy the command prompt or template resolver. Native preparation and import profiles reference this prerequisite rather than copying its stages. Profiles remain declarative JSON. The core exposes generic template, governance-binding, impact, and recognizer registration; Spec Kit command/template adapters and named framework recognizers live in the fullstack/integration layer. `.active-feature` remains a convenience pointer only—every transition resolves an explicit `feature_id`/`run_key` and is capability-bound.

## Design

### Constitution Prerequisite and Impact

Every direct native preparation, full native path nested from `/do-work`, CTO-coordinated
preparation workspace, and external import runs one shared `ensure_project_constitution`
prerequisite. The deterministic usability check accepts a non-empty, structurally valid document
with no unresolved template markers and does not force reapproval for warnings or version
differences alone.

An unusable document blocks the originating cursor and invokes `constitution.json`, a thin
engine wrapper around the existing registered Spec Kit constitution command. That command remains
the sole writer and retains its resolved-template, draft/revision, semantic-version, and
single-file persistence behavior. The TypeScript gate, not prompt prose, is authoritative for
mandatory structural validation. The engine adds proof-bound durable approval with exactly
`approve_continue` and `request_changes`. Approval consumes one idempotent continuation back to
native Specify or external compatibility validation; request changes revises and revalidates the
same draft identity. No entry point can author a fallback constitution or infer approval.

Every later validation, checkpoint approval, compatibility decision, and handoff embeds the exact
constitution version and content SHA-256. A fingerprint change creates one typed semantic-impact
assessment over bound artifacts. `affected` results stale only their dependency closure;
`no_impact` preserves approval only with section/rule evidence. Formatting-only changes avoid
reapproval when stable semantic hashes prove equivalence; missing or ambiguous impact evidence
blocks readiness.

### Phase Pipeline

After the constitution prerequisite succeeds, each native phase uses the same blocking sequence:

1. A `single` or `consilium` stage dispatches the declared analyst/architect/research workers and returns schema-validated typed artifacts. The main session does not draft or repair their content.
2. The engine persists an immutable phase version, resolves the selected language and template, and atomically materializes Markdown through a registered document renderer.
3. Deterministic validation checks mandatory semantic section markers, unresolved clarifications, contradictions, current constitution binding/compliance, traceability, upstream version bindings, safe paths, and implementation readiness. The phase worker's semantic findings are stored alongside deterministic findings; there is no detached reviewer.
4. Only a passing validation result opens a hard-human checkpoint with exactly `approve_continue`, `request_changes`, or `approve_stop`.
5. `request_changes` records feedback and reopens the affected content stage through the existing continuation path; a new capability epoch and artifact version are required. `approve_stop` records approval, advances to the next pending phase, and returns without dispatching it. `approve_continue` advances and dispatches the next phase in the same turn.

Specify, Plan, and Tasks are independently invocable through `/specify`, `/spec-plan`, and `/spec-tasks`, while approve-and-continue remains an explicit convenience. A full specification nested from `/do-work` invokes the same profile stages and subagents; the parent intent changes only what happens after the Tasks checkpoint.

### Identity, Versions, and Staleness

- A feature receives an immutable, branch-independent `feature_id`; the readable directory is `specs/<feature-id>/`.
- New workflow tools carry an explicit feature/run selector. The capability's `issued_for.run_key`, cursor epoch, profile hash, and dispatch marker remain authoritative; an active pointer cannot redirect an in-flight call.
- Every phase version binds the worker dispatch, template hash, language, document hash, validation result, and exact upstream versions.
- Every phase/import version binds the exact constitution version, content fingerprint, and validation reference. A changed fingerprint triggers typed impact analysis before readiness or dispatch.
- Any manual edit or changed upstream semantic hash marks the phase and dependent approvals stale. Presentation-only changes remain current only when a deterministic validation record proves unchanged semantic section hashes; otherwise the safe default is stale.
- Current Markdown is readable state; prior replaced revisions move to `history/`. Machine artifacts are immutable rather than overwritten.

### Templates and Language

Template resolution order is feature override, project/workflow-owner default, then shipped baseline. Language resolution order is feature override, project default, then initiating-request language. Templates use stable semantic section markers independent of localized headings; a project override that omits mandatory markers fails before generation. Template and language changes create a new artifact version and stale every affected approval.

### Handoff and Execution Claim

One versioned implementation handoff contains approved scope, requirement/decision/task/verification traceability, validation status, exact constitution binding and any no-impact evidence, risks, language, source provenance, and exact bound phase versions. `/do-work` and CTO preflight call one readiness predicate over this contract. A constitution change that is affected or not yet assessed makes the handoff non-ready before claim acquisition. A durable execution claim is keyed by handoff digest and permits one active owner (`do-work` run or CTO wave); conflicts fail closed or queue. Claims never grant approval and cannot survive a changed handoff.

### External Intake

`/spec-import <authorized-local-path>` resolves candidate files read-only, rejects escapes/symlinks/unsupported or oversized input, records source revision and SHA-256 fingerprints, redacts secrets, and treats embedded instructions as inert data. Discovery may create the immutable source snapshot, but the shared constitution prerequisite must pass before compatibility validation; a bootstrap interruption resumes that exact snapshot once. Fullstack recognizers may improve mapping for known frameworks, but core generic conformance remains available. The engine produces a readable compatibility report bound to the exact constitution fingerprint, an optional local supplement, and the same handoff schema used by native work. External completion or approval metadata is provenance only; source files are hash-checked before and after intake and never written.

### `/do-work` and CTO Integration

- `/do-work` first resolves an explicit or uniquely matching ready handoff, then verifies its current constitution binding/impact before claim acquisition. A ready handoff skips product/requirements/architecture rediscovery; a partial, stale, constitution-affected/unassessed, conflicting, or ambiguous workspace routes to the earliest affected phase and dispatches no implementation.
- Without a handoff, quick low-risk work retains the lightweight profile, medium work may run focused clarification or bounded Specify, and complex/critical/low-confidence/security/infrastructure work enters the full three-phase profile. Every path that actually enters native Specify first runs the shared constitution prerequisite.
- CTO execution freezes selected handoff versions and current constitution impact results into the existing team plan, obtains the current user’s mapping confirmation, then parallelizes only dependency- and ownership-safe slices.
- CTO preparation delegates each feature to the standard specification profile after its own shared prerequisite succeeds. Independent feature workspaces may run in parallel when their explicit run identities and write scopes do not overlap; facets of one feature serialize behind one phase writer. CTO renders one review packet but records a separate synchronous checkpoint decision in each feature state. Final Tasks approval ends preparation; implementation requires a separate explicit CTO execution wave.

## Implementation Sequence

1. **Addressable workspace and binding foundation** — add branch-independent feature identity, explicit run selection, additive state migration, immutable version pointers, safe paths, typed artifact schemas, and reusable exact-content bindings.
2. **Canonical constitution prerequisite** — add the pure TypeScript usability gate and durable origin descriptor; wrap the existing registered constitution command as the only draft/revision writer in `constitution.json`; add deterministic validation, proof-bound two-decision approval, idempotent continuation, and thin compatibility command registration without copying prompt or persistence logic.
3. **Constitution impact propagation** — bind validations/approvals/compatibility decisions/handoffs to exact version and fingerprint; add versioned semantic-impact assessment, artifact-scoped no-impact evidence, targeted stale dependency closure, and fail-closed readiness.
4. **Phase materialization and gates** — add generic registered renderers/templates, versioned Markdown/history/status projections, validation records, semantic staleness propagation, and the exact three-decision phase checkpoint behavior.
5. **Shared handoff and claim** — define the executor-neutral handoff, one readiness predicate including constitution bindings, conflict routing, and an exclusive handoff-version execution claim before integrating any executor.
6. **First vertical slice: constitution gate + external intake → `/do-work`** — implement generic read-only import, one Spec Kit fixture adapter, compatibility checkpoint, and single-spec `/do-work` execution. This delivers the preferred interoperability slice while proving exact external resume and the shared handoff early.
7. **Native explicit phases** — replace `spec-preparation.json` with delegated Specify/Plan/Tasks stages, shared constitution prerequisite, deterministic materialization, synchronous checkpoints, baseline templates, language precedence, and direct phase commands.
8. **Adaptive `/do-work` preparation** — consume ready native handoffs, add quick/medium/full routing, and make the full nested path call the same prerequisite and subagent stages without main-session authorship.
9. **CTO handoff execution and preparation** — add multi-workspace preflight, frozen specification-to-team/constitution mappings, per-version claims, dependency-safe parallelization, mapping confirmation, bounded standard-profile preparation slices, per-feature synchronous checkpoint fan-in, queue reasons, and the hard stop before implementation.
10. **Remaining compatibility and migration** — add OpenSpec/BMAD/Superpowers/XPowers recognizers, generic hostile/unknown/constitution fixtures, legacy JSON materialization with fresh approval and current bindings, and final cross-profile migration removal.

Tests, runtime scenarios, consumer documentation, and changelog entries land with the slice whose observable contract they protect; they are not deferred to a cleanup-only final phase.

## Complexity Tracking

No constitution violation is accepted. The `specification` directory is a cohesive reusable subsystem inside the existing core, not a second engine. `constitution.json` is a thin engine/checkpoint wrapper around the existing canonical command and template resolver, which remain the only policy writer; native/import profiles call the shared prerequisite and cannot generate their own constitution. Exact content bindings plus evidence-backed semantic impact avoid both under-invalidation and blanket stale churn. The separate `spec-import` profile is a declarative entry path that terminates in the same workspace, constitution authority, checkpoint ledger, readiness predicate, and handoff.
