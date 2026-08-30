# Research: Readable Specification Workflow

## Evidence Basis

Repository research covered the current durable engine, `/do-work` routing, CTO control plane, artifact/document renderers, tests, and runtime harness. The key reusable seams are:

- `packages/core/src/engine/state.ts`, `durable.ts`, `checkpoints.ts`, `workflow-contract.ts`, `artifact-contract.ts`, `fan-in.ts`, and `product-prd.ts`
- `packages/core/workflows/spec-preparation.json`, `product-discovery.json`, `_schema.json`, and `artifacts-schema.json`
- `packages/core/src/commands/do-work.ts`, `cto.ts`, and `register.ts`
- `packages/core/src/cto/` for plans, leases, waves, slice gates, and resident-CTO behavior
- `packages/e2e/` for real OMP PTY scenarios and deterministic process-boundary tests

The project-local Spec Kit installation is useful compatibility evidence, but cannot define the
plugin's runtime contract because consumer projects may not have Spec Kit installed:

- `.omp/commands/speckit.constitution.md` demonstrates a readable draft/revision workflow but is an optional generated command, not an available core dependency
- `.specify/templates/constitution-template.md` and `.specify/memory/constitution.md` define one optional provider convention
- `.specify/templates/plan-template.md` confirms the value of a constitution gate and post-design re-check

External practices were checked against current primary repositories and repository-grounded documentation:

- Spec Kit: <https://github.com/github/spec-kit>
- OpenSpec: <https://github.com/Fission-AI/OpenSpec>
- Superpowers: <https://github.com/obra/superpowers> and <https://github.com/obra/superpowers-skills>
- XPowers: <https://github.com/dpolishuk/xpowers>
- BMAD Method: <https://github.com/bmad-code-org/BMAD-METHOD>

No unresolved `NEEDS CLARIFICATION` remains. Where an external claim could not be verified, it is not used as a design premise.

## Decision 1: Extend the Existing Durable Engine

**Decision**: Implement specification workspaces as additive state, artifact, document, validation, checkpoint, and handoff contracts in the existing engine. Use declarative native/import profiles; do not create a specification-specific state machine.

**Rationale**: The engine already provides capability epochs, trusted answer proofs, idempotent completion, profile hashes, atomic state writes, schema validation, fan-in provenance, document stages, and durable resume. The constitution requires one domain-agnostic core and one owner. The existing `spec-preparation` profile is the correct cutover point, but its JSON-only, checkpoint-free output is incomplete.

**Alternatives considered**:

- Embed Spec Kit or OpenSpec as a dependency — rejected because it would create a second lifecycle and ownership model.
- Build a separate specification service/store — rejected because it would duplicate persistence, checkpoint authority, migration, and dispatch security.
- Keep the current JSON artifacts and improve visualization only — rejected because Markdown must be the primary review and handoff contract.

## Decision 2: Make Feature Identity Explicit and Branch-Independent

**Decision**: Give each workspace an immutable `feature_id` and store it at `specs/<feature-id>/` and `.work-state/features/<feature-id>/`. New workflow tool calls resolve the explicit feature/run identity bound to the capability. `.active-feature` remains only a convenience selector for unambiguous interactive use and a legacy migration input.

**Rationale**: Current state derives the feature slug from the branch and resolves through one active pointer. That conflicts with branch-independent workspaces, explicit phase commands, multiple selected CTO specifications, and safe parallel preparation. The capability already carries `issued_for.run_key`; making it the resolver authority removes a mutable global redirect without adding a new store.

**Alternatives considered**:

- Keep branch-derived slugs — rejected because moving branches would change identity and invalidate otherwise valid work.
- Require a separate worktree for every specification phase — rejected as the only solution because specification documents and state do not modify application source and should be safely addressable by run identity. Separate worktrees remain available for implementation slices.
- Auto-select the first matching workspace — rejected; ambiguity must fail closed and ask for an explicit selection.

## Decision 3: Subagents Author Content; the Engine Materializes Documents

**Decision**: Every Specify, Plan, and Tasks content stage, direct or nested from `/do-work`, is a `single` or `consilium` subagent dispatch. Workers return typed artifact payloads. The engine persists those payloads and deterministically renders Markdown; the main session coordinates tools and checkpoints but never authors or repairs phase content.

**Rationale**: This preserves the existing strict-orchestrator contract and directly satisfies FR-071. `TaskResult.artifacts` and `persistReturnedArtifacts` already provide an engine-owned persistence path, while the product PRD renderer proves deterministic document materialization, safe paths, atomic writes, source/content hashes, and stale-source detection. Engine rendering is formatting and validation, not main-agent specification work.

**Alternatives considered**:

- Generate documents in the main session — rejected by the user requirement and because it mixes orchestration with authorship.
- Let phase workers write arbitrary workspace files — rejected as the default because per-dispatch filesystem confinement is not yet a proven host guarantee. Typed returned artifacts plus engine-owned rendering reduce the write surface.
- Render Markdown from free-form worker prose — rejected because it cannot enforce required sections, traceability, or deterministic version hashes.

## Decision 4: Use Blocking Validation and Synchronous Phase Checkpoints

**Decision**: Each phase runs generate → materialize → validate → checkpoint. Validation must be terminal before the checkpoint appears. The checkpoint allows exactly `approve_continue`, `request_changes`, or `approve_stop`; no detached or asynchronous reviewer can change the result or advance the phase.

**Rationale**: The current checkpoint ledger already binds a human answer to run, stage, work identity, capability, policy, and decision. BMAD supports validate-before-decide, while no reference framework provides OMP's required attributable three-decision durable checkpoint. The user explicitly rejected asynchronous review. Deterministic checks plus the phase worker's schema-bound semantic findings are sufficient before human review; no reviewer job is needed.

**Alternatives considered**:

- Keep the current final `completeness_gate` reviewer — rejected because it produces one late verdict instead of phase-local feedback and resembles the review flow the user does not want.
- Add background reviewers after each phase — rejected because their result could race with or invalidate a human checkpoint.
- Make approval implicit when validation passes — rejected because validation and authorization are different contracts.

## Decision 5: Reuse Continuation for the Three Decisions

**Decision**: `request_changes` records user feedback and reopens the affected content stage through the existing continuation path with a new capability epoch and artifact version. Both approval decisions record proof and advance; `approve_continue` dispatches the next phase in the same turn, while `approve_stop` returns before dispatch and resumes later from the next pending phase.

**Rationale**: Existing checkpoint rules already support exact allowed-decision values, and `reopenFromFeedback` resets the affected stage and downstream stages without discarding history. No new transition engine is required. The behavioral difference between continue and stop is orchestration after the same durable advance.

**Alternatives considered**:

- Add a second approval state machine — rejected as duplication.
- Leave the approved checkpoint stage unadvanced on stop — rejected because resume would appear to repeat an already approved phase.
- Overwrite the current artifact on revision — rejected because approvals must remain attributable to exact historical versions.

## Decision 6: Version Artifacts and Propagate Semantic Staleness

**Decision**: Persist immutable phase versions that bind worker dispatch, template hash, language, upstream versions, document hash, semantic section hashes, validation result, and checkpoint proof. Replace current Markdown only after the new version validates; archive the previous readable revision. Any unproven upstream semantic change marks dependants and approvals stale.

**Rationale**: Current artifact files are latest-only and staleness is primarily branch-based. Product PRD manifests already demonstrate source/content hash validation. Approval and execution must bind exact versions, not paths or mutable status labels.

**Alternatives considered**:

- Store only the latest version — rejected because revisions, audit, resume, and CTO version freeze cannot be proven.
- Infer semantic equivalence from changed prose — rejected. A presentation-only change remains current only when stable section hashes prove no semantic change; otherwise fail safe.
- Copy all machine JSON into user-facing documents — rejected because machine state should remain optional for readers.

## Decision 7: Resolve Templates and Language with Stable Semantic Markers

**Decision**: Resolve templates in the order feature override → project/workflow-owner default → shipped baseline. Resolve language in the order feature override → project default → initiating-request language. Localized templates retain stable semantic section markers; missing required markers block before generation.

**Rationale**: Heading text cannot be the validation API when documents are localized. Stable markers let templates vary presentation without removing required contracts. The selected template and language hashes become part of the phase version, so a later change deterministically triggers regeneration and reapproval.

**Alternatives considered**:

- Validate English heading names — rejected because it breaks localization.
- Permit arbitrary templates and let reviewers notice missing sections — rejected because project customization cannot bypass required gates.
- Add a template engine dependency — rejected; a strict bounded renderer over known markers is sufficient.

## Decision 8: Define One Executor-Neutral Handoff and Readiness Predicate

**Decision**: Native, imported, and migrated workspaces all produce the same versioned implementation handoff. One readiness predicate verifies phase/import bindings, validation, constitution status, approvals, freshness, traceability, and project boundary. `/do-work` and CTO consume that predicate and acquire an exclusive claim keyed by the handoff digest.

**Rationale**: Existing `spec_handoff` is unconstrained, while product handoff and capability/work-identity bindings provide the correct precedent. A shared predicate prevents `/do-work` and CTO from implementing subtly different readiness rules. A version-scoped claim prevents duplicate execution without granting approval.

**Alternatives considered**:

- Let each executor interpret documents independently — rejected because it duplicates planning and allows divergent safety gates.
- Bind execution to a folder name or branch — rejected because both are mutable and not evidence of approval.
- Reuse CTO team leases directly — rejected because they fence team processes, not a specification version across executor types.

## Decision 9: Deliver Read-Only External Intake Through Adapters Plus Generic Conformance

**Decision**: Core owns safe local discovery, immutable snapshots, generic conformance, compatibility reports, supplements, fingerprints, and the common handoff. Fullstack registers Spec Kit, OpenSpec, BMAD, Superpowers, and XPowers recognizers. Unknown readable bundles can use the same generic path.

**Rationale**: Framework layouts and status metadata are heterogeneous. OpenSpec has strong structural validation; Spec Kit has predictable phase files; BMAD and XPowers may use different artifact roots or task stores. Recognition can improve discovery but must not weaken readiness or turn external completion metadata into authorization.

**Alternatives considered**:

- Install each framework and invoke its CLI — rejected because intake must work without the source framework and must not execute embedded behavior.
- Copy or rewrite external files into the native format — rejected because source evidence must remain immutable and attributable.
- Support only named frameworks — rejected because generic Markdown conformance is a stated compatibility requirement.

## Decision 10: Keep `/do-work` Preparation Adaptive but Reuse the Same Full Profile

**Decision**: `/do-work` first looks for an explicit or uniquely matching ready handoff. Without one, quick low-risk work uses the current lightweight path, medium work may request focused clarification or bounded Specify, and complex/critical/low-confidence/security/infrastructure work enters the full native profile. The full nested path dispatches the same subagents and checkpoints as direct phase commands.

**Rationale**: BMAD's phases-as-needed and Spec Kit's lean preset validate right-sized planning. Existing classification, profile registration, roster triggers, and continuation are the correct seams. Reusing the full profile prevents nested `/do-work` from becoming an invisible main-session planning path.

**Alternatives considered**:

- Require the full workflow for every task — rejected as ceremony for quick low-risk changes.
- Let `/do-work` invent a private abbreviated specification — rejected because it would create a second artifact and approval contract.
- Skip validation when the initiating command is `/do-work` — rejected because entry point cannot weaken readiness.

## Decision 11: Integrate CTO at the Handoff Boundary

**Decision**: CTO execution explicitly selects ready handoffs, freezes their versions into the existing team plan, obtains user confirmation, and claims them before dispatch. CTO preparation runs standard specification profiles in bounded subagent slices, renders a combined review packet, and records a separate synchronous user decision in every feature state. Preparation completion never starts implementation.

**Rationale**: The resident CTO, no-nesting gate, team-plan dependency checks, slice markers, roster selection, human answer ledger, and deterministic fan-in already exist. The missing pieces are multi-workspace preflight, version mapping, claims, review-packet rendering, and code-backed queue reasons. Explicit feature/run addressing removes the current active-pointer collision for independent preparation; shared-file or same-feature work still serializes.

**Alternatives considered**:

- Add a CTO-specific specification format or state machine — rejected because it would diverge from direct `/do-work` and violate the constitution.
- Allow CTO or leads to approve phase documents — rejected; human proof is required per workspace.
- Run one asynchronous reviewer over a batch — rejected because mixed per-spec decisions and checkpoint attribution would be lost.

## Decision 12: Migrate Deterministically and Require Fresh Approval

**Decision**: Add an explicit persisted-schema migration that creates feature identity and version ledgers. Compatible legacy JSON-only specification runs may materialize readable documents with provenance, but remain unapproved. Incompatible or ambiguous state is preserved byte-for-byte and returns a blocked migration receipt.

**Rationale**: `normalizePersistedState`, `MigrationReceipt`, `ControlPlaneProvenance`, and CTO schema migration already establish the fail-closed pattern. Old completion cannot prove the current user's approval or the new validation contract.

**Alternatives considered**:

- Treat old completed runs as approved — rejected because approval semantics changed materially.
- Delete or rewrite incompatible legacy state — rejected because migration must not lose source evidence.
- Maintain both old and new runtime paths indefinitely — rejected; legacy shapes are migration inputs, followed by a clean cutover.

## Decision 13: Ship One Native Constitution Workflow as a Blocking Prerequisite

**Decision**: Add one reusable `ensure_project_constitution` prerequisite and a plugin-shipped `constitution.json` workflow to the existing durable engine. Direct native preparation, full preparation nested from `/do-work`, CTO-coordinated preparation, and external intake all call this prerequisite instead of implementing entry-point-specific logic. Provider resolution uses explicit `constitution.path`, then exactly one discovered existing provider, then the native root `CONSTITUTION.md` default. A usable constitution binds the originating run and continues without a checkpoint. A missing, empty, unresolved-template, or structurally invalid constitution dispatches a declared subagent to produce a typed `ConstitutionDraft`; the engine materializes it through the selected provider, validates it, presents the two-decision checkpoint, and resumes the exact origin idempotently.

**Rationale**: Spec Kit is a design reference and optional provider, not a guaranteed installation. Depending on `.omp/commands/speckit.constitution.md`, its CLI, namespace, or template resolver would violate the domain-agnostic core and make native specification preparation unavailable in ordinary consumer projects. A shipped workflow plus provider seam supplies one generation/validation/approval contract while still allowing an existing `.specify/memory/constitution.md` to remain the selected project policy.

**Repository seams**:

- Implement the deterministic usability check beside `packages/core/src/gates/validation.ts`; external scripts and prompt instructions are not authoritative validation.
- Ship `packages/core/workflows/constitution.json`, a framework-neutral baseline template, typed draft schema, deterministic renderer, and native `CONSTITUTION.md` provider. Reuse the existing `checkpoint_policy.rules` → typed `workflow_checkpoint` → trusted-answer ledger path; no constitution-specific checkpoint automaton is needed.
- Because the prerequisite can run before an originating specification workflow exists, persist an explicit origin descriptor (entry kind, run/workspace or import snapshot identity, arguments, capability epoch) and consume its continuation marker exactly once.
- Model the bootstrap rule as hard-human `constitution_approval` with only `approve_continue` and `request_changes`; keep it distinct from the three-decision phase policy.
- Register Spec Kit only as an optional existing-file provider. Detection reads local metadata/files; it never invokes `/speckit.constitution`, a CLI, or an external template resolver.

**Alternatives considered**:

- Copy constitution generation into Specify and import profiles — rejected because revisions, validation, approval, and persistence would diverge immediately.
- Use the Spec Kit constitution command as the canonical writer — rejected because Spec Kit may be absent and external integration commands cannot be core runtime dependencies.
- Always write `.specify/memory/constitution.md` — rejected because it couples all consumers to an external framework namespace; the neutral default is `CONSTITUTION.md`.
- Silently select among several existing constitution files — rejected because competing project policies must fail closed and require explicit `constitution.path`.
- Require constitution approval on every start — rejected because a current structurally usable constitution must proceed without ceremony; warning-only and version-only differences are not blocking.
- Reuse the normal three-decision phase checkpoint — rejected because the constitution bootstrap has exactly `approve_continue` and `request_changes`; there is no approve-and-stop outcome while the originating flow is blocked.
- Resume from prompt history or re-run the entry command — rejected because interruption between approval and resume would duplicate drafts, decisions, or downstream dispatch.

## Decision 14: Bind Exact Constitution Content and Propagate Only Proven Semantic Impact

**Decision**: Every phase validation, phase approval, compatibility decision, and implementation handoff records a `ConstitutionBinding` containing provider id, resolved project-relative path, constitution version, exact content SHA-256, semantic hash, and validation reference. When the exact content fingerprint changes, the engine runs one versioned semantic impact assessment over the dependency graph. Each bound artifact receives an explicit `affected` or `no_impact` result with evidence; only affected artifacts and dependent handoffs become stale. Formatting-only changes retain approvals when stable semantic-section hashes prove no impact.

**Rationale**: Exact fingerprints provide deterministic drift detection, while semantic hashes and recorded impact evidence prevent a harmless formatting change from invalidating every approved feature. The existing immutable artifact/version model and dependency-based stale propagation are the correct substrate; the assessment becomes another typed, attributable engine artifact rather than an implicit model judgment.

**Repository seams**:

- Reuse `writeArtifact` and `CompletionEnvelope.artifact_refs` for immutable `constitution-impact.vN` evidence in the existing feature artifact directory.
- Reuse the `product-prd.ts` content/source hash revalidation pattern and existing phase dependency closure rather than adding a project-wide invalidation store.
- Extend strict persisted-state validation, artifact schemas, producers, consumers, and `MigrationReceipt` together. A migrated workspace with no current constitution binding fails closed on first use until impact/revalidation establishes one.

**Alternatives considered**:

- Invalidate every workspace after any constitution byte change — rejected by FR-078 and because it creates unnecessary reapproval for formatting-only amendments.
- Trust only the semantic version string — rejected because content can change without a correct bump and the same version can otherwise bind different policy.
- Let each executor re-interpret constitution drift — rejected because `/do-work` and CTO would produce inconsistent readiness decisions.
- Preserve approvals without explicit no-impact evidence — rejected because an unassessed policy change must fail closed.

## Reference Practices Adopted and Rejected

| Reference | Adopt | Reject |
| --- | --- | --- |
| Spec Kit | Explicit Constitution → Specify → Plan → Tasks progression, project-scoped readable policy, feature documents, plan auxiliaries, templates, lean path; optional `.specify/memory/constitution.md` provider | Required command/CLI/template dependency; external namespace as the universal default; branch identity as workspace authority; toolkit-coupled executor; implicit review between commands |
| OpenSpec | Readable change workspace, structural conformance, preserved history, explicit verification | Unrecorded “review by editing Markdown”; write-back/sync as part of initial interoperability |
| Superpowers | Subagent-driven drafting, file-based briefs, reviewable phase packets | Main-session authorship and execution-phase background review as specification approval |
| XPowers | One canonical task source, immutable approved requirements during execution | Parallel reviewer agents as a human checkpoint substitute |
| BMAD | Risk-based process depth and validate-before-decide readiness | A second role/lifecycle hierarchy or unverified historical numeric scale levels |
