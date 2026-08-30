# Quickstart: Validate the Readable Specification Workflow

This guide is for validating the implemented feature end to end. It does not replace `tasks.md`, package tests, or release checks.

## Prerequisites

- Node.js 20 or newer
- npm workspace dependencies installed
- An OMP runtime compatible with the package peer range
- An authorized scratch repository for runtime scenarios
- The fullstack bundle, or the private monorepo bundle, registered as the single workflow owner
- Spec Kit and every other external specification framework absent for the native zero-dependency constitution scenario
- No production deployment or publication is required for this feature validation

From the repository root:

```bash
npm ci
npm run build
npm run typecheck
```

Before interactive E2E validation, create the persistent checklist required by repository policy:

```text
vibe-report/readable-spec-workflow-e2e-scenario.md
```

Record every scenario below as an action plus expected result. Re-read that checklist before each validation action and continue from the first incomplete item.

## Contract-Level Validation

Run the affected package suites after the corresponding implementation slice lands:

```bash
npm run test:core
npm run test:fullstack
npm run test -w @andvl1/omp-workflows-internal
npm run test -w @andvl1/omp-workflows-e2e
```

Expected outcomes:

- All shipped profile JSON files validate against `packages/core/workflows/_schema.json`.
- Every JSON Schema in `specs/001-redesign-spec-workflow/contracts/` parses and is represented by executable artifact-contract tests.
- New persisted state is accepted only through the migration/normalization path.
- Existing workflow owner, capability, checkpoint, document renderer, CTO, and command tests remain green.
- Focused tests cover success and fail-closed cases; source-text assertions are not accepted as behavioral evidence.
- Constitution fixtures prove zero-dependency native generation, provider precedence/ambiguity, identical prerequisite behavior for every required entry point, the exact two-decision bootstrap checkpoint, idempotent resume, exact provider/fingerprint bindings, and targeted semantic impact.
- Completion fixtures prove the `quality_gates_and_artifacts` migration, exact handoff/claim binding, complete matrix success, missing implementation evidence, review rejection, test failure, stale or contradictory evidence, changed intent, CTO per-feature isolation, and rejection of any separate DoD or human completion override.

## Runtime Harness Setup

Build and bootstrap a scratch project:

```bash
npm run build -w @andvl1/omp-workflows-e2e
npm run e2e -- bootstrap readable-spec-workflow feat/readable-spec-workflow
```

Use the printed scratch path in the remaining examples (shown below as `/tmp/omp-ux-e2e-readable-spec-workflow`). Start only the scenario currently being validated:

```bash
npm run e2e -- start /tmp/omp-ux-e2e-readable-spec-workflow \
  --scenario packages/e2e/scenarios/spec-workflow.json \
  --detach
```

Inspect pending checkpoints and submit one answer at a time:

```bash
npm run e2e -- ask /tmp/omp-ux-e2e-readable-spec-workflow --list
npm run e2e -- ask /tmp/omp-ux-e2e-readable-spec-workflow "1"
```

Inspect evidence without re-running completed steps:

```bash
npm run e2e -- transcript /tmp/omp-ux-e2e-readable-spec-workflow --tail 80
```

Stop the session only through the harness:

```bash
npm run e2e -- stop /tmp/omp-ux-e2e-readable-spec-workflow
```

For the harness web surface, follow repository policy and drive it with `playwright-cli`; do not substitute another browser tool.

## Scenario 0: Constitution Prerequisite and Exact Resume

Run each entry point against separate scratch fixtures:

- direct `/specify`
- full native preparation nested from `/do-work`
- CTO-coordinated specification preparation
- `/spec-import` with compatibility validation pending

Exercise provider resolution separately:

- no configured path, no existing provider, and no Spec Kit installation → native `CONSTITUTION.md`
- explicit authorized `constitution.path` → exact configured path
- only an existing `.specify/memory/constitution.md` fixture, with no Spec Kit executable installed → optional `speckit` file provider
- both `CONSTITUTION.md` and `.specify/memory/constitution.md` present with no override → ambiguity failure
- escaping, unreadable, or unsafe configured path → provider validation failure

For every entry point, exercise a missing file, empty file, unresolved-template document,
structurally invalid document, valid document with warnings, and valid document whose version
differs from the last observed version.

For an unusable constitution:

1. Confirm the originating flow stops before native Specify generation or external compatibility validation.
2. Confirm the plugin-native `constitution.json` workflow dispatches a declared content subagent, receives a typed draft, and materializes one readable file through the selected provider.
3. Inspect the checkpoint and choose `request_changes` with concrete feedback.
4. Confirm the same draft identity is revised through a new version, revalidated, and presented at the same checkpoint.
5. Choose `approve_continue`.
6. Interrupt and resume once between approval recording and origin dispatch to exercise idempotency.

Expected outcomes:

- Missing, empty, unresolved-template, and structurally invalid fixtures invoke the same plugin-native workflow and present exactly `approve_continue` and `request_changes`.
- With no external framework installed, the shipped template/provider produces root `CONSTITUTION.md`; no `/speckit.constitution`, CLI, package installation, or remote access occurs.
- Provider precedence is explicit override → exactly one discovered provider → native default. Multiple candidates fail closed with `SPEC_CONSTITUTION_SOURCE_AMBIGUOUS`.
- A valid constitution proceeds without generation or reapproval; warning-only and version-only differences do not block.
- Approval is attributable, binds provider id, resolved path, exact version and content fingerprint, and resumes the exact native Specify or external compatibility-validation origin exactly once.
- Requested changes never create a second constitution workflow, draft identity, checkpoint authority, or persistence path.
- No specification worker, compatibility validator, implementation worker, or CTO implementation slice starts while the prerequisite is unresolved.

## Scenario 1: Explicit Specify → Plan → Tasks

1. Submit:

   ```text
   /specify Add a project-local workflow profile override with deterministic ownership
   ```

2. Wait for the Specify worker to finish.
3. Inspect `specs/<feature-id>/spec.md`, `status.md`, and `validation/specify.md`.
4. Select `approve_stop`.
5. Start a new session and submit:

   ```text
   /spec-plan --feature <feature-id>
   ```

6. Select `approve_continue` at Plan.
7. At Tasks, select `approve_stop`.

Expected outcomes:

- Specify, Plan, and Tasks are each independently invocable.
- Every content artifact is attributable to a declared subagent dispatch in canonical state/runtime events.
- The main session contains orchestration/tool/checkpoint work only; it does not author phase content.
- Markdown documents, validation results, current approvals, and next action are understandable without opening JSON.
- `approve_stop` preserves approval and a later command resumes at the next unapproved phase.
- Plan validation includes the post-design constitution check.
- Final Tasks approval creates `handoff.md` and a ready machine handoff, but the direct preparation flow starts no implementation.

## Scenario 2: Request Changes and Stale Downstream Artifacts

1. Complete and approve Specify and Plan.
2. At the Tasks checkpoint, choose `request_changes` with concrete feedback.
3. Confirm the Tasks worker receives only the current artifacts and feedback, produces a new version, and validation runs again.
4. Revise the approved Specify document semantically through `/specify --feature <feature-id> ...`.

Expected outcomes:

- Request changes reopens only the affected phase and dependencies through a new capability epoch.
- The prior readable version is retained under `history/` and its approval remains attributable to that old version.
- A semantic Specify change marks Plan, Tasks, and the handoff stale before any implementation can dispatch.
- The status view identifies the earliest phase to revalidate.
- No asynchronous reviewer appears after the checkpoint or mutates the decision.

## Scenario 2A: Constitution Change Impact

1. Prepare multiple approved native and imported handoffs bound to the same constitution fingerprint.
2. Apply a formatting-only constitution edit and run readiness for `/do-work` and CTO.
3. Apply a semantic amendment that affects only one requirement/decision subset.
4. Apply a semantic amendment that affects every approved workspace.
5. Attempt execution before and after the required targeted revalidation and reapproval.

Expected outcomes:

- Every validation, approval, compatibility decision, and handoff exposes the exact constitution version and content fingerprint used.
- Formatting-only changes retain approvals only with recorded artifact-scoped `no_impact` evidence.
- A partial semantic amendment stales only affected phase artifacts, imported handoffs, and their dependency closure; unaffected artifacts retain approval with explicit evidence.
- A global semantic amendment stales every affected handoff before `/do-work` or CTO acquires a claim.
- Missing, ambiguous, or failed impact analysis blocks dispatch with an actionable diagnostic; it never defaults to no impact or unconditional reapproval.
- Revalidation and reapproval create bindings to the new fingerprint without rewriting external source files.

## Scenario 3: Approved Handoff Consumption by `/do-work`

1. Use a workspace whose Specify, Plan, and Tasks versions are current, validated, approved, and fully traceable.
2. Submit:

   ```text
   /do-work --spec <feature-id> implement the approved task graph
   ```

Expected outcomes:

- `/do-work` runs the shared readiness predicate and acquires an execution claim for the exact handoff digest.
- Product discovery, requirement elicitation, and architecture selection are skipped.
- Implementation/review/QA gates remain present.
- A second `/do-work` or CTO execution attempt for the same digest fails closed or queues with `SPEC_EXECUTION_CLAIMED`.
- If the task text conflicts with approved scope, no implementation dispatch occurs and the response routes to the earliest affected specification phase.

## Scenario 3A: Requirement Closure Blocks Feature Completion

Use the same approved handoff and execute these fixtures independently through `/do-work` and CTO:

1. Complete every approved task and provide implementation evidence plus a passing review artifact
   for every requirement and acceptance scenario; provide passing executed-test or runtime evidence
   for every row marked `observable_behavior`.
2. Remove implementation evidence from one requirement row.
3. Return a failing review verdict for one acceptance scenario.
4. Return green generic quality gates but failing executed-test evidence for one observable behavior.
5. Reuse otherwise-passing evidence from an older handoff digest or another CTO feature.
6. Submit evidence showing that the implementation intentionally differs from approved scope.
7. Attempt to finish by supplying a separate feature DoD or an explicit human completion
   acknowledgement.

Expected outcomes:

- The complete fixture creates one immutable typed result and readable
  `validation/implementation-conformance.md` containing exactly one row per approved requirement and
  acceptance scenario, then completes the claim and workspace.
- Missing implementation evidence, a failed review, a failed or absent required executed test,
  stale/cross-feature evidence, or contradictory evidence returns
  `SPEC_IMPLEMENTATION_CONFORMANCE_FAILED`, keeps the active owner claim, and names the exact
  remediation.
- Green project/profile gates do not close a missing specification row.
- `changed_intent` returns `SPEC_IMPLEMENTATION_INTENT_CHANGED`, blocks the claim, and routes to the
  earliest affected specification phase instead of accepting the implementation as a silent spec
  revision.
- Neither a separate feature DoD nor a human acknowledgement changes a blocking verdict.
- Replaying identical passing inputs returns the established conformance result without duplicating
  a matrix, claim transition, or completion event.

## Scenario 4: Adaptive `/do-work` Without a Workspace

Exercise one request in each class:

- clear low-risk quick change
- medium ambiguous change
- complex or low-confidence feature
- security/infrastructure-sensitive feature

Expected outcomes:

- Quick work uses the lightweight path and records why a full specification was unnecessary.
- Medium ambiguity requests focused clarification or bounded Specify.
- Complex, critical, low-confidence, security, and infrastructure work enters the full native specification profile.
- The full path dispatches Specify/Plan/Tasks content to subagents exactly as the direct commands do.
- Validation completes before every synchronous checkpoint.

## Scenario 5: Read-Only External Intake

Create a complete local Spec Kit fixture and record its hashes:

```bash
shasum -a 256 fixtures/spec-kit-complete/spec.md \
  fixtures/spec-kit-complete/plan.md \
  fixtures/spec-kit-complete/tasks.md
```

Submit:

```text
/spec-import fixtures/spec-kit-complete --framework spec-kit
```

Inspect the recognition result and compatibility report, then approve the compatibility checkpoint and run:

```text
/do-work --spec <imported-feature-id> implement the approved imported handoff
```

Re-run the same `shasum -a 256` command.

Expected outcomes:

- Source file hashes are byte-for-byte unchanged.
- Import records selected and ignored paths, adapter/version, source revision when available, and exact fingerprints.
- External approval/completion metadata is shown only as provenance.
- A complete bundle reaches one compatibility checkpoint without running native Specify, Plan, and Tasks.
- Re-importing unchanged files is idempotent and returns the established snapshot and approval state.
- Editing any bound source after approval marks the handoff stale before further dispatch.

## Scenario 6: Incomplete, Ambiguous, and Hostile Imports

Validate these fixtures independently:

- missing task graph
- OpenSpec delta with a missing baseline
- multiple plausible framework layouts in one directory
- unknown but readable Markdown bundle
- path traversal and escaping symlink
- oversized or unsupported file
- embedded prompt-injection text, executable snippets, and secret-like content

Expected outcomes:

- Missing information is classified as supplement-required, blocked, or unsupported with actionable findings.
- Ambiguous candidates require explicit user selection.
- Generic intake remains available for unknown readable bundles and uses the same conformance rules.
- Path escape, unsafe links, unsupported content, and oversized input fail before delegation.
- Embedded instructions remain inert data; secrets are redacted or rejected.
- No source file is modified and no implementation begins.

## Scenario 7: Language and Template Resolution

1. Set a project default language and a valid project template override.
2. Create a feature without a feature override.
3. Create another feature with an explicit different language/template.
4. Attempt to use a template missing a mandatory semantic marker.
5. Change the language of an already approved feature.

Expected outcomes:

- Resolution follows feature override → project default → initiating-request language.
- Technical identifiers and authoritative quotations remain accurate.
- All generated prose and validation summaries use the selected language.
- The invalid template blocks before worker dispatch.
- A post-approval language/template change creates new versions and stales affected approvals.

## Scenario 8: CTO Executes Ready Handoffs

Select two ready workspaces containing independent and dependent tasks, then submit an explicit CTO execution request.

Expected outcomes:

- CTO preflight freezes exact handoff digests and rejects any partial, stale, ambiguous, or already-claimed workspace.
- The team mapping covers every approved task, dependency, shared contract, and completion-evidence requirement.
- The current user confirms the mapping before implementation workers start.
- Independent slices may run in parallel; dependent/shared-file/migration slices serialize.
- Results map back to the original requirement and task ids.
- CTO never changes specification approvals or validation outcomes.
- CTO builds and validates one closure matrix per frozen handoff digest; a blocked feature retains its claim while independent passing features may complete.

## Scenario 9: CTO Prepares Specifications

Submit a CTO preparation request containing two independent features and two facets of one third feature.

Expected outcomes:

- Independent features receive distinct standard workspaces and bounded specification slices.
- Facets of one feature converge behind one phase writer and one workspace.
- Phase content is generated by standard profile subagents, not the resident CTO.
- CTO may render one review packet, but each feature/phase receives a separate synchronous user decision.
- Mixed decisions advance only eligible workspaces.
- Final Tasks approvals return implementation-ready handoffs and end the preparation wave; no implementation starts without a new explicit CTO execution request.

## Scenario 10: Legacy Migration and Interrupted Resume

Validate three fixtures:

- compatible JSON-only completed specification run
- incompatible/malformed legacy run
- interrupted new-format run after one recorded approval

Expected outcomes:

- Compatible legacy content materializes readable documents with provenance but no inferred approval.
- Incompatible state remains byte-for-byte unchanged and produces a blocked migration receipt with exact missing/incompatible fields.
- Interrupted new-format work resumes from the first unapproved phase without duplicating approved artifacts, trusted answers, dispatches, or phase versions.

## Evidence to Preserve

For every runtime scenario, retain:

- command and checkpoint transcript
- generated `status.md`, phase document, validation report, and handoff where applicable
- canonical event evidence showing worker dispatch identity for phase content
- pre/post external source hashes for import scenarios
- claim/preflight result for `/do-work` and CTO scenarios
- constitution provider selection, usability, typed-draft dispatch, two-decision checkpoint, exact-origin resume, binding, and semantic-impact records
- per-handoff implementation-conformance result, readable closure matrix, review/test/quality-gate evidence references, and terminal claim/workspace transition
- screenshots for the real OMP UI surface
- focused package/process test output

Generate the harness report after completing the scenario checklist:

```bash
npm run e2e -- report /tmp/omp-ux-e2e-readable-spec-workflow \
  --steps steps.json \
  --copy-evidence
```

A passing result requires all expected behaviors above, zero implementation dispatch from an incomplete, stale, ambiguous, unsafe, unapproved, or already-claimed handoff, and zero feature completion without a current passing requirement-closure matrix bound to the exact approved handoff and execution claim.
