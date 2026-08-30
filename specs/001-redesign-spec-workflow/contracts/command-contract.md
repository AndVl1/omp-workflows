# Command and Extension Contract

## Scope

This contract defines the public command behavior, shared workflow-tool bindings, bundle extension seams, and fail-closed errors for readable specification workspaces. Commands are entry points into the existing workflow engine; they do not own independent state.

A workflow-owner prefix is applied through the existing `commandName(prefix, base)` seam. Examples below use bare fullstack command names; the private monorepo bundle exposes the same behavior with its configured prefix.

## Global Invariants

1. Every state-changing call identifies the authorized project and explicit `feature_id`/`run_key`.
2. Capability id, cursor epoch, profile hash, work identity, and dispatch marker remain mandatory after `workflow_begin`.
3. Constitution, Specify, Plan, and Tasks content originates from declared subagent dispatches. The main session may coordinate, pass exact typed results to engine tools, render deterministic documents/status, and ask for checkpoint decisions; it cannot author semantic content.
4. Validation reaches a terminal result before a checkpoint is presented.
5. Checkpoints are synchronous hard-human decisions. Neither an agent, CTO, lead, policy default, validation pass, nor external status can approve.
6. Any ambiguous, stale, invalid, conflicting, unauthorized, or already-claimed input performs no implementation dispatch.
7. Native Specify generation and external compatibility validation require a current successful shared constitution prerequisite.
8. Constitution bootstrap uses the plugin-shipped workflow, template, provider resolver, deterministic validation, materialization, and checkpoint contract; entry points and external adapters cannot replace or duplicate it.
9. Every validation, approval, compatibility decision, readiness result, and handoff binds the exact constitution provider, resolved path, version, and content fingerprint used.
10. A specification-backed execution cannot become complete until one current handoff-bound implementation-conformance matrix passes; generic quality gates, task/team completion, or human acknowledgement cannot waive missing closure evidence.

## Shared Constitution Prerequisite

`ensure_project_constitution(origin)` is one engine-owned prerequisite invoked by:

- direct `/specify`
- the full native profile entered from `/do-work`
- every CTO-coordinated native preparation workspace
- `/spec-import` immediately before compatibility validation

`origin` binds the authorized project, originating run key, capability epoch, and exact resume target
(`specify` or `compatibility_validation`). The prerequisite is idempotent and its resume marker can
be consumed exactly once.

Provider resolution is deterministic:

1. Use an explicit authorized project `constitution.path` when configured.
2. Otherwise select exactly one existing path reported by registered providers.
3. If no provider path exists, select the native provider at project-root `CONSTITUTION.md`.
4. If several existing providers are plausible, return `SPEC_CONSTITUTION_SOURCE_AMBIGUOUS` and require an explicit path; do not choose by registration order or framework confidence.

The shipped native provider, profile, template, renderer, and validator are always available.
Registered providers contribute bounded path/template metadata only. Discovery never invokes a
framework command, CLI, package manager, remote service, or prompt.

Usability checks are deterministic and classify the canonical constitution as:

- `usable`: file exists, is non-empty, has no unresolved template markers, and passes mandatory structural validation
- `constitution_required`: file is missing, empty, contains unresolved template markers, or fails mandatory structure
- `blocked`: the path, workflow owner, profile, or persisted prerequisite state is invalid or ambiguous

A usable constitution is fingerprinted, bound to the origin, and resumes it without a checkpoint.
Warnings and a version difference alone do not require generation or reapproval.

`constitution_required` invokes the plugin-shipped `constitution.json` profile as a blocking child
workflow. A declared subagent returns a typed `ConstitutionDraft`; the engine resolves the selected
template, materializes the provider path, performs authoritative deterministic validation, versions
the draft, and persists it. This works when no external framework is installed. Once the draft
passes validation, the prerequisite presents exactly:

| Decision | Required payload | Durable effect | Coordinator effect |
| --- | --- | --- | --- |
| `approve_continue` | Current trusted user answer proof | Approves and fingerprints the current constitution version | Consumes the resume marker and enters the exact originating target once |
| `request_changes` | Trusted proof plus non-empty feedback | Reopens the same constitution draft identity with a new artifact version | Re-dispatches the native content worker with feedback, revalidates, and repeats this checkpoint |

There is no `approve_stop` constitution-bootstrap decision because the originating flow remains
blocked until a current constitution is approved. Interruption safely resumes the prerequisite;
it does not re-create the draft or re-run the originating command.

When a previously bound constitution fingerprint changes, readiness invokes a versioned semantic
impact assessment before any new dispatch. Only `affected` artifacts and their dependency closure
become stale. `no_impact` preserves approval only with artifact-scoped evidence; an unassessed,
ambiguous, or failed assessment blocks execution.

## User Commands

### `/specify [--feature <feature-id>] <request>`

Creates a new native workspace or revises/resumes the Specify phase of an explicit workspace.

Preconditions:

- The project root is authorized.
- A supplied `feature-id` resolves to exactly one workspace.
- Without `--feature`, creation is allowed only when the request does not conflict with an active normalized feature identity; resume is allowed only when selection is unambiguous.
- Plan or Tasks content that depends on a revised Specify version is marked stale before any further phase dispatch.

Behavior:

1. Run the shared constitution prerequisite; if bootstrap is required, wait for its two-decision checkpoint and resume this exact Specify origin only after approval.
2. Prepare/resume the standard native specification profile.
3. Dispatch the declared Specify subagent roster.
4. Persist typed output, materialize `spec.md` and `status.md`, and run validation bound to the current constitution fingerprint.
5. On failure, report actionable findings and remain on Specify.
6. On pass, present the three-decision phase checkpoint.

### `/spec-plan --feature <feature-id>`

Generates or revises the Plan phase.

Preconditions:

- Specify has a current passing validation and human approval.
- The approved Specify version matches the current version.
- No unresolved project constitution violation exists.

Behavior:

- Dispatches bounded repository research and one owning Plan writer through the profile roster.
- Produces typed decisions and, when applicable, `research.md`, `data-model.md`, `contracts/`, and `quickstart.md` inputs.
- Materializes `plan.md` and auxiliaries deterministically.
- Re-evaluates constitution compliance after design, then presents the checkpoint only on pass.

### `/spec-tasks --feature <feature-id>`

Generates or revises the Tasks phase.

Preconditions:

- Specify and Plan are current, passing, approved, and mutually version-bound.

Behavior:

- Dispatches the declared task-author subagent.
- Produces one canonical, acyclic, dependency-aware task graph with requirement and verification links.
- Materializes `tasks.md`, validates complete traceability, and presents the checkpoint.
- After approval, creates or refreshes the executor-neutral handoff and `handoff.md`.

### `/spec-import <authorized-local-path> [--framework <id|generic>]`

Creates or resumes a read-only external intake.

Preconditions:

- Path resolves inside the authorized project boundary.
- Input is local supported text; remote fetch, binary extraction, framework installation, and write-back are not allowed.

Behavior:

1. Discover candidates without executing source instructions.
2. If recognition or document selection is ambiguous, return candidates and require explicit selection.
3. Fingerprint exact selected files and create an immutable import snapshot.
4. Run the shared constitution prerequisite before compatibility validation. If bootstrap is required, preserve the import snapshot and resume this exact import at compatibility validation only after approval.
5. Apply the registered framework recognizer or generic conformance mapping.
6. Render a compatibility report with ready/supplement-required/blocked/unsupported status, bound to the current constitution fingerprint.
7. If ready, or once a local supplement closes all gaps, present one synchronous compatibility checkpoint.
8. On approval, produce the same implementation-handoff schema used by native workspaces.
9. Re-hash selected sources and the constitution before return; a changed source or unassessed constitution change blocks approval and leaves source files untouched.

### `/do-work [--spec <feature-id|workspace-path>] <task>`

Preflight order:

1. Resolve an explicit `--spec` selection when present.
2. Otherwise detect only a unique workspace whose approved scope matches the task.
3. If a ready current handoff exists, verify its constitution binding (including any required impact assessment), acquire its execution claim, and start the selected implementation profile without product/requirements/architecture rediscovery.
4. If a matching workspace is partial, stale, conflicting, invalid, ambiguously affected by constitution drift, or ambiguous, dispatch no implementation and route to the earliest affected specification phase or required selection.
5. If no workspace matches, choose lightweight, bounded Specify, or full specification preparation from complexity, confidence, and risk; run the shared constitution prerequisite before any full native Specify dispatch.

A full nested specification preparation invokes the same native profile and subagents as the direct commands. After the Tasks checkpoint:

- `approve_continue` may continue into implementation because the initiating command already expressed implementation intent and the handoff claim is acquired first.
- `approve_stop` returns an implementation-ready handoff without implementation.
- `request_changes` remains in the Tasks revision loop.
- Terminal advancement runs the shared implementation-conformance gate over the exact handoff and active claim. The run, claim, and workspace complete only when every requirement/scenario row and mandatory quality gate passes.

### `/cto <request containing explicit feature workspace selections>`

CTO preparation and execution share the resident CTO and existing CTO → lead → worker hierarchy.

Execution contract:

- Resolve every selected workspace and run the common readiness predicate.
- Verify every handoff's current constitution binding and block affected or unassessed drift before freezing the team plan.
- Freeze exact handoff digests into the CTO team plan.
- Acquire claims before implementation dispatch.
- Map every implementation task to one team/slice, dependencies, shared contracts, and completion evidence.
- Present the mapping for current-user confirmation.
- Parallelize only admitted dependency- and ownership-safe slices; conflicts serialize or block.
- Team completion evidence is partitioned by frozen handoff digest and evaluated through the same shared implementation-conformance gate. A passing feature may complete independently; a blocked feature retains its claim and cannot borrow evidence from another specification.

Preparation contract:

- Each feature uses the standard native specification profile and its explicit run identity.
- Run the shared constitution prerequisite for each feature before its first Specify dispatch; independent prerequisite runs may progress separately, but each retains its own exact origin.
- Content generation is delegated to bounded phase subagents.
- One readable review packet may fan in several workspaces, but every phase decision is recorded separately in the corresponding workspace.
- Final approval returns handoffs and ends the preparation wave. A separate explicit CTO execution wave is required.
- A nested CTO is never created.

## Checkpoint Contract

Every native phase checkpoint has exactly these decisions:

| Decision | Required payload | Durable effect | Coordinator effect |
| --- | --- | --- | --- |
| `approve_continue` | Current trusted user answer proof | Approves exact artifact version and advances | Dispatch next eligible phase in the same turn |
| `request_changes` | Trusted proof plus non-empty feedback | Records decision, invalidates affected current approval, reopens content stage with new epoch | Re-dispatch same phase and revalidate |
| `approve_stop` | Current trusted user answer proof | Approves exact artifact version and advances | Return before dispatch; later explicit command resumes next phase |

A failed validation never opens the checkpoint. A checkpoint decision cannot be changed in the same capability epoch; revision creates a new epoch and artifact version.

The shared constitution prerequisite uses the separate two-decision contract defined above. It
cannot be widened to the phase checkpoint's three decisions, and a phase approval cannot satisfy
constitution approval.

## Phase Worker Result Contract

A content-producing worker returns typed artifacts through the task result; it does not write human-readable workspace documents.

Required envelope fields:

- `feature_id`
- `phase`
- `dispatch_id`, `capability_id`, and `capability_epoch`
- `artifact_version_candidate`
- normalized semantic sections required by the resolved template
- stable requirement/decision/task/verification identifiers and links appropriate to the phase
- explicit assumptions and unresolved items
- phase-local semantic validation findings
- exact `ConstitutionBinding` used to generate and validate the result
- source/provenance references

The engine rejects undeclared artifacts, missing required fields, invalid identifiers, mismatched dispatch identity, or output for a different feature/phase. Only the engine may persist the canonical version and materialize Markdown.

## Shared Readiness Contract

The common readiness result is one of:

- `ready`: all required bindings are current and an executor may attempt to claim the handoff.
- `incomplete`: a named phase/import requirement is not complete.
- `stale`: one or more bound versions/hashes no longer match.
- `ambiguous`: workspace, source mapping, or task scope requires explicit selection.
- `blocked`: validation, constitution usability or unassessed impact, security, ownership, or claim conflict prevents execution.

A non-ready result includes:

- stable error code
- affected workspace and earliest affected phase
- exact artifact/version/path evidence
- actionable next command or user decision
- confirmation that no implementation dispatch occurred

## Shared Completion Conformance Contract

This contract applies to every execution that acquired a specification handoff, regardless of
whether `/do-work`, CTO mode, or a future executor owns the claim.

1. After implementation, review, testing, and selected-profile quality gates finish, the executor
   submits only typed artifact references already attributable to the active run and claim.
2. Core loads the exact approved handoff and derives the complete closure subject set. Executors
   cannot add, remove, rename, reinterpret, or waive requirements or acceptance scenarios.
3. Core creates exactly one `RequirementClosureEntry` for each approved requirement and each
   acceptance scenario. Every entry requires implementation evidence and a passing review verdict;
   an entry whose frozen verification obligation has `observable_behavior: true` also requires
   current passing executed-test or runtime-scenario evidence.
4. Constitution- and profile-mandated quality gates are evaluated as additional required rows.
   They cannot substitute for a missing or failed specification row.
5. The immutable result binds `feature_id`, `handoff_id`, `handoff_digest`, active claim, execution
   owner/run, and profile hash. Evidence from another handoff, claim, feature, or stale run is
   rejected.
6. `pass` permits terminal `workflow_advance`, completes the claim and workspace, and idempotently
   returns the established matrix on replay. `blocked` keeps the current claim active and reports
   exact implementation/review/test remediation. `changed_intent` blocks the claim and routes to
   the earliest affected specification phase.
7. `workflow_complete` remains dispatch completion evidence only. It cannot mark the feature,
   claim, do-work run, or CTO mapping complete without the conformance gate.
8. No separate feature-specific Definition of Done or completion override is accepted. The approved
   specification plus required constitution/profile quality gates is the complete contract.

The readable projection is written to
`specs/<feature-id>/validation/implementation-conformance.md`; canonical state stores only the
immutable typed result reference and derived status.

## Bundle Extension Seams

### Constitution Provider

Core always registers the native provider:

- `provider_id`: `native`
- default path: `CONSTITUTION.md`
- framework-neutral shipped template
- engine-owned materialization through safe, atomic writes

An optional bundle adapter may report an existing project constitution such as
`.specify/memory/constitution.md` and, when explicitly selected, a compatible template override.
Providers return data only: stable id/version, bounded candidate path, detection evidence, template
metadata, and safe-write capability. They cannot generate content, invoke external commands or
CLIs, approve checkpoints, change validation, select themselves when another candidate exists, or
introduce provider-specific state machines. Spec Kit installation is never a prerequisite.

### Template Provider

A workflow owner may register versioned phase templates and a project default language. Providers return template id, phase, content hash, semantic markers, supported language metadata, and source provenance. Registration cannot remove required markers, replace checkpoint policy, change the readiness predicate, or write project configuration after user ownership begins.

### Format Recognizer

A bundle may register a recognizer with:

- unique `recognizer_id` and version
- framework id
- bounded detection rules
- candidate artifact mapping
- normalization function that returns data only
- ignored-candidate reasons

Recognizers cannot execute source commands, fetch remote content, mutate source, authorize approval, weaken generic conformance, or create a different handoff shape. Unknown formats retain the generic recognizer.

## Stable Error Codes

| Code | Meaning |
| --- | --- |
| `SPEC_SELECTION_AMBIGUOUS` | More than one workspace or source mapping is plausible. |
| `SPEC_FEATURE_CONFLICT` | The normalized feature identity already has a conflicting active run. |
| `SPEC_PHASE_PREREQUISITE` | Upstream phase/import approval is missing or stale. |
| `SPEC_VALIDATION_FAILED` | Mandatory validation failed; findings identify remediation. |
| `SPEC_APPROVAL_REQUIRED` | Validation passed but no current trusted user decision exists. |
| `SPEC_STALE` | A bound document, template, language, source, supplement, or upstream version changed. |
| `SPEC_PATH_UNAUTHORIZED` | A path is outside the project boundary, unsafe, or unsupported. |
| `SPEC_IMPORT_AMBIGUOUS` | External candidate selection or framework recognition requires user choice. |
| `SPEC_EXTERNAL_CHANGED` | External source changed during/after fingerprinted intake. |
| `SPEC_HANDOFF_NOT_READY` | The common readiness predicate rejected execution. |
| `SPEC_EXECUTION_CLAIMED` | Another active executor owns the same handoff digest. |
| `SPEC_PROFILE_MISMATCH` | Persisted profile/version cannot be safely resumed without migration. |
| `SPEC_MIGRATION_BLOCKED` | Legacy state cannot be mapped without loss or unsafe inference. |
| `SPEC_CONSTITUTION_SOURCE_AMBIGUOUS` | More than one existing constitution provider/path is plausible; configure `constitution.path`. |
| `SPEC_CONSTITUTION_PROVIDER_INVALID` | The selected provider, path, template, or safe-write contract is missing, unauthorized, or invalid. |
| `SPEC_CONSTITUTION_REQUIRED` | The canonical constitution is missing, empty, unresolved, or structurally invalid; the prerequisite must complete. |
| `SPEC_CONSTITUTION_APPROVAL_REQUIRED` | A generated/corrected constitution passed validation but lacks a current trusted two-decision checkpoint answer. |
| `SPEC_CONSTITUTION_CHANGED` | The exact constitution fingerprint differs from a bound validation, approval, compatibility decision, or handoff. |
| `SPEC_CONSTITUTION_IMPACT_PENDING` | Semantic impact is missing, ambiguous, or failed; affected execution remains blocked. |
| `SPEC_IMPLEMENTATION_CONFORMANCE_FAILED` | Requirement closure is missing, failed, stale, contradictory, or lacks mandatory review/test evidence; terminal advancement is blocked. |
| `SPEC_IMPLEMENTATION_INTENT_CHANGED` | Submitted implementation evidence conflicts with the approved handoff; revise the earliest affected specification phase. |

All errors are fail-closed and preserve canonical state unless the documented operation is an explicit migration, revision, or claim-state transition.

## Versioning and Cutover

- Persisted and exported contract additions are versioned together with profile schemas, artifact schemas, producers, consumers, tests, and docs.
- The native constitution profile/template/provider are shipped and tested as the zero-dependency path; Spec Kit and other provider adapters remain optional and cannot become peer/runtime dependencies.
- Every public/persisted DoD-labelled generic completion contract is cleanly renamed: `dod_and_artifacts` → `quality_gates_and_artifacts`, `CompletionDodStatus` → `CompletionQualityGateStatus`, and `CompletionArtifactRef.dod_status` → `quality_gate_status`. The migration reader maps legacy values/fields once, records provenance, and leaves no alias in active schemas, prompts, profiles, or runtime output; the exported/persisted cutover receives a semantic-version bump and consumer migration note.
- Legacy branch-derived and JSON-only shapes are accepted only by the migration reader.
- Successful migration records provenance and requires new validation plus human approval.
- After the migration window, no command, alias, or renderer may continue the old JSON-only specification path.
