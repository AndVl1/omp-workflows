# Feature Specification: Readable Specification Workflow

**Feature Branch**: `sdd-integration`

**Created**: 2026-08-30

**Status**: Draft

**Input**: User description: "Redesign the plugin's specification-generation workflow so that specification, plan, and tasks are readable, structured, explicitly reviewable, language-configurable, and ready for a reliable handoff to `/do-work`; use Spec Kit as the primary reference and assess useful practices from OpenSpec, Superpowers, XPowers, and BMAD."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a readable implementation-ready specification (Priority: P1)

As a developer, I want specification work split into explicit Specify, Plan, and Tasks phases that produce predictable human-readable documents, so I can understand and review what will be built before implementation begins.

**Why this priority**: The current JSON-only output is difficult to read and does not expose a trustworthy path from a raw request to implementation-ready work.

**Independent Test**: Start a feature from a natural-language request, complete the three phases, and verify that a reviewer can locate the problem, scope, requirements, design decisions, implementation plan, tasks, and current readiness without opening or interpreting machine-state files.

**Acceptance Scenarios**:

1. **Given** a new feature request, **When** the user starts the Specify phase, **Then** the workflow creates one discoverable feature workspace with a structured specification document based on the active template.
2. **Given** an approved specification, **When** the Plan phase completes, **Then** the feature workspace contains a readable plan that traces design decisions and verification strategy back to approved requirements.
3. **Given** an approved plan, **When** the Tasks phase completes, **Then** the workspace contains a dependency-aware task list whose tasks trace to requirements and state observable completion evidence.
4. **Given** a completed feature workspace, **When** a reviewer opens it, **Then** the phase order, current status, approvals, validation results, and next valid action are visible without parsing JSON.

---

### User Story 2 - Review, revise, pause, and resume at checkpoints (Priority: P1)

As a reviewer, I want an explicit checkpoint after Specify, Plan, and Tasks, so I retain control over scope and quality while being able to continue immediately, request changes, or stop safely.

**Why this priority**: A specification workflow is not trustworthy if phase transitions are implicit or if approval cannot be distinguished from continuation.

**Independent Test**: Exercise all three checkpoint decisions at each phase and verify that the workflow advances, revises, or pauses exactly as selected while preserving durable state across a new session.

**Acceptance Scenarios**:

1. **Given** a phase artifact that passes validation, **When** the checkpoint is shown, **Then** the user can choose exactly one of: approve and continue, request changes, or approve and stop.
2. **Given** the user chooses approve and continue, **When** the decision is recorded, **Then** the current phase becomes approved and the next phase starts without requiring the user to restate context.
3. **Given** the user chooses request changes, **When** feedback is supplied, **Then** the workflow remains on the current phase, updates only the affected content, re-runs validation, and presents the checkpoint again.
4. **Given** the user chooses approve and stop, **When** the session ends, **Then** a later explicit phase command resumes from the first unapproved phase without repeating approved work.
5. **Given** an approved upstream artifact is revised later, **When** the revision changes a downstream dependency, **Then** affected downstream approvals are marked stale and cannot be used for implementation until revalidated and reapproved.

---

### User Story 3 - Hand an approved specification to do-work (Priority: P1)

As a developer, I want `/do-work` to recognize a complete specification workspace as authoritative input, so implementation starts from approved tasks instead of rediscovering requirements or architecture.

**Why this priority**: The specification workflow delivers value only when it removes ambiguity and redundant discovery from implementation while retaining validation and safety gates.

**Independent Test**: Invoke `/do-work` for a feature whose Specify, Plan, and Tasks phases are approved and verify that implementation begins from the approved task set, with requirement and verification context preserved.

**Acceptance Scenarios**:

1. **Given** a complete, approved, and current feature workspace, **When** `/do-work` is invoked for that feature, **Then** it consumes the approved specification, plan, tasks, decisions, and validation evidence as the implementation contract.
2. **Given** an approved implementation contract, **When** `/do-work` prepares execution, **Then** it skips redundant product discovery, requirements elicitation, and architecture selection while retaining implementation, review, testing, and completion gates.
3. **Given** the requested implementation conflicts with an approved artifact, **When** `/do-work` detects the conflict, **Then** it pauses and routes the user back to the earliest affected specification phase rather than silently changing scope.
4. **Given** a partial or stale feature workspace, **When** `/do-work` is invoked, **Then** it resumes or requests completion of the earliest incomplete phase and does not begin implementation.

---

### User Story 4 - Right-size work when no specification exists (Priority: P2)

As a developer, I want `/do-work` to adapt its preparation depth when no specification exists, so small changes remain efficient while complex or risky features receive deliberate specification and human validation.

**Why this priority**: Always requiring the full workflow creates unnecessary overhead, while always skipping it leaves complex work under-specified.

**Independent Test**: Invoke `/do-work` without a feature workspace for representative quick, medium, complex, and critical requests and verify that the selected preparation path matches the declared complexity and risk.

**Acceptance Scenarios**:

1. **Given** no specification and a clear low-risk quick task, **When** `/do-work` classifies the request with high confidence, **Then** it may continue with a lightweight preparation path and records why the full specification workflow was unnecessary.
2. **Given** no specification and a medium request with unresolved scope, **When** `/do-work` prepares execution, **Then** it requires focused clarification or a bounded Specify phase before implementation.
3. **Given** no specification and a complex, critical, low-confidence, security-sensitive, or infrastructure-sensitive request, **When** `/do-work` prepares execution, **Then** it starts the nested specification workflow and requires the same human checkpoints before implementation.
4. **Given** a nested specification workflow is paused, **When** the user returns later, **Then** `/do-work` resumes the nested workflow from durable state rather than starting a second run.

---

### User Story 5 - Select language and adapt templates (Priority: P2)

As a plugin user or workflow owner, I want to select the language of specification documents and use project-appropriate templates, so artifacts are readable to their intended audience without losing a stable phase contract.

**Why this priority**: Readability depends on audience language and consistent document structure; custom plugin consumers also need controlled adaptation without creating incompatible workflows.

**Independent Test**: Create equivalent feature workspaces using two selected languages and a project template override, then verify that all human-readable prose follows the selected language while required phase sections, validation, and handoff remain complete.

**Acceptance Scenarios**:

1. **Given** a language selected for the feature, **When** any phase produces or revises a document, **Then** all generated prose uses that language while code identifiers, command names, and quoted source text remain unchanged when translation would reduce accuracy.
2. **Given** no feature language override, **When** a feature workspace is created, **Then** the workflow uses the project default; if no project default exists, it uses the language of the initiating request and records the choice.
3. **Given** a project template override, **When** a phase starts, **Then** the workflow uses the resolved template and still enforces mandatory content, validation, checkpoint, and handoff contracts.
4. **Given** the feature language is changed after an approval, **When** documents are regenerated, **Then** affected approvals become stale and the translated artifacts require revalidation and reapproval.

---

### User Story 6 - Recover and migrate existing specification runs (Priority: P3)

As an existing user, I want JSON-only or interrupted specification runs handled explicitly, so the redesign does not silently lose work or incorrectly declare old artifacts implementation-ready.

**Why this priority**: Persisted workflow contracts must evolve deterministically, but migration can follow the primary new-work path.

**Independent Test**: Open representative legacy, interrupted, malformed, and already-completed runs and verify that each receives a deterministic resume, migration, or actionable rejection outcome with no silent data loss.

**Acceptance Scenarios**:

1. **Given** a compatible legacy JSON-only run, **When** the user opens it, **Then** the workflow can materialize the new readable documents with provenance and requires human review before marking them approved.
2. **Given** a legacy run that cannot be mapped safely, **When** migration is attempted, **Then** the workflow leaves the original data unchanged and reports the exact missing or incompatible information.
3. **Given** a partially completed new workflow, **When** it resumes after interruption, **Then** previously approved artifacts and checkpoint decisions remain intact and no phase is duplicated.

### Edge Cases

- Two features normalize to the same short name or the user starts the same feature twice.
- The active branch changes while a feature workspace remains valid and is intentionally independent from branch naming.
- A user invokes Plan before Specify is approved, Tasks before Plan is approved, or `/do-work` before Tasks is approved.
- A user edits a readable artifact manually after validation or approval.
- Machine state says a phase is approved but the corresponding document is missing, changed, malformed, or outside the authorized feature workspace.
- Validation succeeds but the human rejects the content, or validation fails but the user requests continuation.
- The session terminates after approval is recorded but before the next phase starts.
- A revision affects only presentation rather than meaning; the workflow must still explain whether downstream approvals remain current.
- Multiple feature workspaces could plausibly match a `/do-work` request.
- A template is missing mandatory sections, cannot be resolved, or conflicts with the project constitution.
- A selected language is ambiguous, unsupported by the active model, or produces mixed-language prose.
- Concurrent sessions attempt to revise or approve the same phase.
- A nested specification run is already active when `/do-work` is invoked again.
- Existing JSON contains secrets or untrusted text that must not be exposed unsafely in rendered documents.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose Specify, Plan, and Tasks as explicit, independently invocable user phases with a documented order and next action.
- **FR-002**: The system MUST create exactly one stable feature workspace per specification run, independent of git branch naming, and make its location visible to the user and downstream commands.
- **FR-003**: Each feature workspace MUST contain predictable human-readable phase documents for specification, plan, and tasks, plus a readable indication of current status, validation, approvals, and next action.
- **FR-004**: Machine-readable state MAY support orchestration, but users MUST NOT need to read or interpret it to understand, review, resume, or hand off the feature.
- **FR-005**: Each phase MUST resolve and apply a versioned template that defines mandatory sections and permits project-level customization without removing required contracts.
- **FR-006**: Specify MUST capture the problem, actors, user journeys, scope, non-goals, constraints, testable requirements, edge cases, assumptions, dependencies, and measurable success criteria.
- **FR-007**: Plan MUST capture repository-grounded context, considered options, selected decisions and rationale, boundaries, contracts, data and control flow, compatibility and migration impact, security and operational concerns, and verification strategy.
- **FR-008**: Tasks MUST produce dependency-aware, independently verifiable work items that identify their originating requirements, expected outcome, affected scope, and completion evidence.
- **FR-009**: Every functional requirement MUST trace to acceptance scenarios, plan decisions, one or more implementation tasks, and verification evidence before the feature is marked implementation-ready.
- **FR-010**: The workflow MUST validate each phase before presenting its human checkpoint and MUST show pass/fail status with actionable findings in a readable form.
- **FR-011**: Validation MUST cover required sections, unresolved clarifications, contradictions, scope bounds, traceability, stale dependencies, constitution compliance, and implementation readiness appropriate to the current phase.
- **FR-012**: A failed mandatory validation MUST block approval and continuation; the user MUST receive the specific failing criteria and a path to revise the artifact.
- **FR-013**: After a phase passes validation, the checkpoint MUST offer exactly three decisions: approve and continue, request changes, and approve and stop.
- **FR-014**: A request-changes decision MUST capture the user's feedback, revise only the affected phase and dependencies, re-run validation, and return to the same checkpoint.
- **FR-015**: An approve-and-stop decision MUST persist approval and allow a later explicit command to resume at the earliest unapproved phase without repeating approved work.
- **FR-016**: Checkpoint decisions, phase transitions, and resume behavior MUST be durable, explicit, attributable, and idempotent.
- **FR-017**: Revising an approved upstream artifact MUST identify and mark semantically affected downstream artifacts stale; stale artifacts MUST NOT authorize implementation.
- **FR-018**: The user MUST be able to select a feature document language, and the workflow MUST resolve it using this precedence: feature override, project default, initiating-request language.
- **FR-019**: The selected language MUST apply consistently to generated prose across all phase documents, validation findings, and handoff summaries while preserving technical identifiers and authoritative quotations where appropriate.
- **FR-020**: The language choice and its source MUST be visible in the feature workspace; changing it after approval MUST trigger regeneration, validation, and approval of affected artifacts.
- **FR-021**: A feature MUST be marked implementation-ready only when Specify, Plan, and Tasks are current, pass validation, and carry explicit human approval.
- **FR-022**: `/do-work` MUST detect an unambiguous implementation-ready feature workspace and use its approved documents and traceability as the authoritative implementation contract.
- **FR-023**: When an implementation-ready workspace exists, `/do-work` MUST skip redundant discovery and planning stages while retaining all implementation, review, testing, security, and completion gates required by the selected execution profile.
- **FR-024**: If `/do-work` receives a request that conflicts with approved scope or decisions, it MUST fail closed and route revision to the earliest affected specification phase.
- **FR-025**: If a matching workspace is partial, stale, invalid, or ambiguous, `/do-work` MUST NOT begin implementation and MUST report the exact phase or user decision required.
- **FR-026**: Without a matching workspace, `/do-work` MUST select preparation depth from task complexity, confidence, and risk rather than applying one universal path.
- **FR-027**: Clear, low-risk quick work MAY use a lightweight preparation path; complex, critical, low-confidence, security-sensitive, or infrastructure-sensitive work MUST enter the full specification workflow before implementation.
- **FR-028**: A specification workflow nested from `/do-work` MUST use the same documents, validation, checkpoints, language behavior, and durable resume rules as a directly invoked workflow.
- **FR-029**: The system MUST prevent duplicate active runs for the same feature identity and MUST make concurrent or conflicting revisions fail closed with a recoverable diagnostic.
- **FR-030**: Legacy JSON-only runs MUST be migrated deterministically when sufficient information exists, retain provenance, require fresh human approval, and preserve original data on migration failure.
- **FR-031**: The redesign MUST preserve domain-agnostic workflow contracts and allow authorized workflow owners to supply templates and defaults without creating a second state machine or bypassing required gates.
- **FR-032**: Runtime-facing command, checkpoint, state, artifact, and handoff behavior MUST be verifiable through the real plugin workflow, including successful, blocked, stale, resume, and migration paths.
- **FR-033**: The final handoff MUST summarize approved scope, decisions, task order, validation status, open risks, selected language, and the exact next `/do-work` action in human-readable form.

### Requirement Acceptance Map

| Requirements | Acceptance evidence |
| --- | --- |
| FR-001–FR-005 | User Story 1 scenarios 1 and 4; User Story 5 scenario 3 |
| FR-006–FR-009 | User Story 1 scenarios 1–3; User Story 3 scenario 1 |
| FR-010–FR-017 | User Story 2 scenarios 1–5 |
| FR-018–FR-020 | User Story 5 scenarios 1–4 |
| FR-021–FR-025 | User Story 3 scenarios 1–4 |
| FR-026–FR-028 | User Story 4 scenarios 1–4 |
| FR-029 | Concurrent-session, duplicate-feature, and duplicate-nested-run edge cases |
| FR-030 | User Story 6 scenarios 1–3 |
| FR-031 | User Story 5 scenario 3 plus constitution-compliance validation |
| FR-032–FR-033 | User Story 3 scenarios 1–4 and SC-010 |

### Key Entities

- **Feature Workspace**: The durable, discoverable home for one feature's readable documents, language choice, current phase, validation summaries, and implementation handoff.
- **Phase Artifact**: A versioned human-readable output for Specify, Plan, or Tasks, including provenance and the upstream artifact versions it depends on.
- **Template Set**: The mandatory structure and guidance used to create each phase artifact, with a resolved source and version.
- **Validation Result**: A phase-specific set of passed and failed quality criteria, actionable findings, artifact version, and timestamp.
- **Checkpoint Decision**: An attributable user choice to approve and continue, request changes, or approve and stop, bound to one validated artifact version.
- **Traceability Link**: A relationship connecting a requirement to acceptance scenarios, plan decisions, tasks, and verification evidence.
- **Implementation Handoff**: The current approved contract that allows `/do-work` to begin implementation without repeating specification work.
- **Language Preference**: The selected document language, its source, and the artifact versions to which it applies.
- **Legacy Specification Run**: Existing JSON-only or prior-format state that may be migrated but is never assumed approved merely because it completed under an older workflow.

### Reference-Informed Product Direction

- Adopt Spec Kit's explicit Specify → Plan → Tasks progression, stable templates, and feature-scoped document organization.
- Adopt OpenSpec's readable change workspace, brownfield orientation, editable artifacts, explicit verification, and preserved history rather than treating a completed document as disposable.
- Adopt Superpowers' practice of presenting reviewable chunks and requiring sign-off before deeper planning or execution.
- Adopt XPowers' separation of planning, execution, review, and verification, with one canonical task handoff instead of parallel task sources.
- Adopt BMAD's right-sized process: simple work avoids ceremony, while ambiguous or high-risk work receives deeper collaborative planning.
- Do not adopt an implicit-only workflow, JSON-only user contract, universal heavyweight path, or any design where approval, continuation, and validation are inferred from free text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In usability review, at least 90% of target users can identify the current phase, latest approval, validation status, and next valid action within 30 seconds of opening a feature workspace.
- **SC-002**: 100% of completed workflows expose specification, plan, tasks, checkpoint decisions, validation summaries, and final handoff in human-readable form without requiring JSON inspection.
- **SC-003**: 100% of implementation-ready features have complete requirement-to-acceptance-to-plan-to-task-to-verification traceability with no stale or unapproved links.
- **SC-004**: Across representative quick, medium, complex, critical, stale, and missing-spec scenarios, `/do-work` selects the expected preparation path in 100% of acceptance tests and never begins implementation from a partial or invalid handoff.
- **SC-005**: A user can pause after any approved phase and resume from the correct next phase in no more than one explicit workflow invocation, with zero repeated approved phases.
- **SC-006**: For each supported document language used in acceptance testing, 100% of generated prose follows the selected language and retains required structure, traceability, and validation quality.
- **SC-007**: In a pilot comparison against the current JSON-only workflow, at least 80% of reviewers rate the new structure as clearer and more trustworthy for approving implementation.
- **SC-008**: 100% of upstream revisions that change approved meaning either invalidate all affected downstream approvals or produce explicit evidence that no downstream dependency changed.
- **SC-009**: 100% of compatible legacy fixtures migrate without data loss, and 100% of incompatible fixtures remain unchanged while producing actionable diagnostics.
- **SC-010**: Across interrupted sessions and representative success, blocked, stale, resume, migration, and handoff cases, users receive the expected next action in 100% of acceptance tests and no invalid state begins implementation.

## Assumptions

- The redesign will treat Markdown documents as the primary user-facing contract; compact machine-readable state remains acceptable for orchestration, validation, and idempotent resume.
- The preferred baseline workspace contains one readable document per phase and a readable status or handoff view; exact auxiliary filenames are finalized during planning as long as discoverability remains stable.
- Explicit phase commands and checkpoint-driven continuation coexist: users may invoke each phase manually, while approve-and-continue provides a deliberate convenience path.
- Human approval is required at all three phase boundaries for the full workflow; autonomous implementation does not imply autonomous specification approval.
- The current project constitution remains authoritative, and every template and validation profile includes an explicit constitution-compliance check.
- Existing workflow owners and command-registration boundaries remain in force; this feature changes the specification experience and `/do-work` handoff, not ownership semantics.
- Research of Spec Kit, OpenSpec, Superpowers, XPowers, and BMAD informs planning, but the plugin keeps its own domain-agnostic, durable workflow engine rather than embedding another framework.
- Bug-fix, emergency, research-only, CTO, and product-discovery workflows are outside this feature except where they intentionally invoke or consume the shared specification handoff contract.
