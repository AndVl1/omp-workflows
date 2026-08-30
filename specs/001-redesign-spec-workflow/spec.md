# Feature Specification: Readable Specification Workflow

**Feature Branch**: `sdd-integration`

**Created**: 2026-08-30

**Status**: Draft

**Input**: User description: "Redesign the plugin's specification-generation workflow so that specification, plan, and tasks are readable, structured, explicitly reviewable, language-configurable, and ready for reliable execution through `/do-work` or CTO mode; support read-only execution of specifications prepared by other frameworks; use Spec Kit as the primary reference and assess useful practices from OpenSpec, Superpowers, XPowers, and BMAD."

## Clarifications

### Session 2026-08-30

- Q: Какие решения должен предлагать нулевой чекпоинт после генерации конституции проекта? → A: «Одобрить и продолжить» или «Запросить изменения»; в нативном потоке одобрение сразу запускает Specify.
- Q: Когда существующую конституцию нужно считать непригодной и направлять в цикл генерации и одобрения? → A: Когда файл отсутствует, пуст, содержит незаполненные шаблонные маркеры или не проходит обязательную структурную проверку.
- Q: В каких точках входа нужно выполнять нулевую проверку конституции? → A: Во всех нативных потоках и при импорте внешней спецификации перед compatibility validation.
- Q: Как нулевой шаг должен создавать или исправлять конституцию? → A: Переиспользовать существующий constitution workflow как блокирующий prerequisite и продолжить после его одобрения.
- Q: Что должно происходить с уже одобренными спецификациями и implementation handoff после смыслового изменения конституции? → A: Выполнять impact analysis, помечать stale только затронутые артефакты и требовать их повторную валидацию и одобрение.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a readable implementation-ready specification (Priority: P1)

As a developer, I want specification work split into explicit Specify, Plan, and Tasks phases that produce predictable human-readable documents, so I can understand and review what will be built before implementation begins.

**Why this priority**: The current JSON-only output is difficult to read and does not expose a trustworthy path from a raw request to implementation-ready work.

**Independent Test**: Start a feature from a natural-language request, complete the three phases, and verify that a reviewer can locate the problem, scope, requirements, design decisions, implementation plan, tasks, and current readiness without opening or interpreting machine-state files.

**Acceptance Scenarios**:

1. **Given** a specification-generation request, **When** the workflow prepares to enter Specify, **Then** it checks whether the project has a usable constitution before creating the specification artifact.
2. **Given** a non-empty project constitution with no unresolved template markers that passes mandatory structural checks, **When** the constitution check completes, **Then** the workflow continues to Specify without generating or reapproving the constitution.
3. **Given** a missing, empty, structurally invalid, or unfilled template constitution, **When** the optional bootstrap step is required, **Then** the workflow invokes the canonical constitution workflow to generate or correct a readable draft, presents exactly approve-and-continue and request-changes decisions, and does not enter Specify yet.
4. **Given** the user requests constitution changes, **When** feedback is supplied, **Then** the canonical constitution workflow revises and revalidates the same draft and presents the same checkpoint again.
5. **Given** the user approves the generated constitution, **When** the attributable decision is recorded, **Then** the constitution becomes the current project policy and Specify starts immediately.
6. **Given** a completed constitution check, **When** the Specify phase completes, **Then** the workflow creates one discoverable feature workspace with a structured specification document based on the active template.
7. **Given** an approved specification, **When** the Plan phase completes, **Then** the feature workspace contains a readable plan that traces design decisions and verification strategy back to approved requirements.
8. **Given** an approved plan, **When** the Tasks phase completes, **Then** the workspace contains a dependency-aware task list whose tasks trace to requirements and state observable completion evidence.
9. **Given** a completed feature workspace, **When** a reviewer opens it, **Then** the phase order, current status, approvals, validation results, and next valid action are visible without parsing JSON.

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
6. **Given** the current constitution differs from the version bound to an approved artifact or handoff, **When** semantic impact analysis runs, **Then** only affected specifications, plans, tasks, and handoffs become stale and require revalidation and reapproval, while unaffected artifacts retain approval with recorded no-impact evidence.

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

### User Story 4 - Execute specifications from other frameworks (Priority: P1)

As a developer with a completed specification from another framework, I want to validate and execute it through this plugin without rewriting it into a new format, so existing planning work can reach `/do-work` or CTO mode quickly and safely.

**Why this priority**: Read-only intake of an already prepared specification is the smallest useful interoperability slice. It can deliver implementation value before the redesigned generation workflow is complete, provided the plugin normalizes and validates the external contract instead of trusting folder names or framework status.

**Independent Test**: Select representative Spec Kit, OpenSpec, BMAD, Superpowers/XPowers-style, and generic Markdown specification bundles, then verify that complete bundles reach one explicit compatibility checkpoint and execute through the standard handoff while incomplete, changed, ambiguous, or unsafe bundles remain blocked with actionable findings.

**Acceptance Scenarios**:

1. **Given** an explicit path to an external specification bundle, **When** intake starts, **Then** the workflow discovers candidate requirements, plan, task, decision, and validation artifacts read-only and records their framework, source paths, source revision, and content fingerprint.
2. **Given** an external bundle that contains the required implementation contract, **When** compatibility validation passes, **Then** the workflow produces the same executor-neutral implementation handoff used by native specifications plus a readable source-to-handoff mapping.
3. **Given** a complete external handoff, **When** the user approves the compatibility checkpoint, **Then** `/do-work` or CTO mode can begin from the imported tasks without repeating internal Specify, Plan, and Tasks phases.
4. **Given** an external bundle with missing or ambiguous required information, **When** compatibility validation runs, **Then** it separates blocking gaps from warnings, proposes only the necessary local supplement, and starts no implementation.
5. **Given** the user approves a compatibility supplement, **When** the external source and supplement together satisfy readiness, **Then** they form one versioned handoff while the original external files remain unchanged.
6. **Given** an approved imported handoff whose external source later changes, **When** execution or resume is attempted, **Then** the handoff becomes stale and requires re-import, impact review, and renewed approval.
7. **Given** framework-specific metadata is unknown or unavailable but the documents are readable, **When** the user identifies the relevant files, **Then** the generic intake path applies the same conformance validation without requiring that framework to be installed.
8. **Given** external documents contain embedded instructions, unsafe links, secrets, unsupported files, or paths outside the authorized project boundary, **When** intake evaluates them, **Then** it treats content as untrusted data, redacts or rejects unsafe material, and performs no unauthorized action.
9. **Given** any external specification intake, **When** the workflow prepares to run compatibility validation, **Then** it applies the same constitution gate as native specification preparation and resumes the original intake only after any required constitution approval.

---


### User Story 5 - Right-size work when no specification exists (Priority: P2)

As a developer, I want `/do-work` to adapt its preparation depth when no specification exists, so small changes remain efficient while complex or risky features receive deliberate specification and human validation.

**Why this priority**: Always requiring the full workflow creates unnecessary overhead, while always skipping it leaves complex work under-specified.

**Independent Test**: Invoke `/do-work` without a feature workspace for representative quick, medium, complex, and critical requests and verify that the selected preparation path matches the declared complexity and risk.

**Acceptance Scenarios**:

1. **Given** no specification and a clear low-risk quick task, **When** `/do-work` classifies the request with high confidence, **Then** it may continue with a lightweight preparation path and records why the full specification workflow was unnecessary.
2. **Given** no specification and a medium request with unresolved scope, **When** `/do-work` prepares execution, **Then** it requires focused clarification or a bounded Specify phase before implementation.
3. **Given** no specification and a complex, critical, low-confidence, security-sensitive, or infrastructure-sensitive request, **When** `/do-work` prepares execution, **Then** it starts the nested specification workflow and requires the same human checkpoints before implementation.
4. **Given** a nested specification workflow is paused, **When** the user returns later, **Then** `/do-work` resumes the nested workflow from durable state rather than starting a second run.

---

### User Story 6 - Select language and adapt templates (Priority: P2)

As a plugin user or workflow owner, I want to select the language of specification documents and use project-appropriate templates, so artifacts are readable to their intended audience without losing a stable phase contract.

**Why this priority**: Readability depends on audience language and consistent document structure; custom plugin consumers also need controlled adaptation without creating incompatible workflows.

**Independent Test**: Create equivalent feature workspaces using two selected languages and a project template override, then verify that all human-readable prose follows the selected language while required phase sections, validation, and handoff remain complete.

**Acceptance Scenarios**:

1. **Given** a language selected for the feature, **When** any phase produces or revises a document, **Then** all generated prose uses that language while code identifiers, command names, and quoted source text remain unchanged when translation would reduce accuracy.
2. **Given** no feature language override, **When** a feature workspace is created, **Then** the workflow uses the project default; if no project default exists, it uses the language of the initiating request and records the choice.
3. **Given** a project template override, **When** a phase starts, **Then** the workflow uses the resolved template and still enforces mandatory content, validation, checkpoint, and handoff contracts.
4. **Given** the feature language is changed after an approval, **When** documents are regenerated, **Then** affected approvals become stale and the translated artifacts require revalidation and reapproval.

---

### User Story 7 - Recover and migrate existing specification runs (Priority: P2)

As an existing user, I want JSON-only or interrupted specification runs handled explicitly, so the redesign does not silently lose work or incorrectly declare old artifacts implementation-ready.

**Why this priority**: Persisted workflow contracts must evolve deterministically, but migration can follow the primary new-work path.

**Independent Test**: Open representative legacy, interrupted, malformed, and already-completed runs and verify that each receives a deterministic resume, migration, or actionable rejection outcome with no silent data loss.

**Acceptance Scenarios**:

1. **Given** a compatible legacy JSON-only run, **When** the user opens it, **Then** the workflow can materialize the new readable documents with provenance and requires human review before marking them approved.
2. **Given** a legacy run that cannot be mapped safely, **When** migration is attempted, **Then** the workflow leaves the original data unchanged and reports the exact missing or incompatible information.
3. **Given** a partially completed new workflow, **When** it resumes after interruption, **Then** previously approved artifacts and checkpoint decisions remain intact and no phase is duplicated.

---

### User Story 8 - Execute approved specifications through CTO mode (Priority: P2)

As a developer with one or more approved feature specifications, I want CTO mode to execute their task graphs through parallel teams when safe, so coordinated implementation can scale without discarding specification decisions or traceability.

**Why this priority**: The implementation handoff should be executor-neutral. CTO mode can add value for broad or multi-team work, but only if it preserves the approved contract and does not reinterpret or duplicate it.

**Independent Test**: Give CTO mode two implementation-ready specifications containing both independent and dependent tasks, then verify that it validates the handoffs, presents a traceable team mapping for approval, runs only independent slices in parallel, and reports results against each original specification.

**Acceptance Scenarios**:

1. **Given** one or more explicitly selected implementation-ready feature workspaces, **When** CTO mode prepares a run, **Then** it validates their identity, current approvals, artifact versions, dependencies, and execution availability before creating a team plan.
2. **Given** approved tasks with non-overlapping ownership and no dependency between them, **When** CTO mode decomposes the work, **Then** it may assign them to parallel team slices while preserving requirement, task, and verification links.
3. **Given** tasks that share contracts, files, migrations, destructive steps, or ordering dependencies, **When** CTO mode decomposes the work, **Then** it establishes a shared contract or serial order before dispatch instead of forcing parallel execution.
4. **Given** a proposed specification-to-team mapping, **When** CTO mode reaches plan confirmation, **Then** the user can review the selected specifications, frozen versions, team slices, dependencies, and parallelization decisions before any implementation worker starts.
5. **Given** a selected workspace that is partial, stale, ambiguous, conflicting, or already being executed elsewhere, **When** CTO mode performs preflight, **Then** it dispatches no implementation work and reports the exact revision, selection, or ownership action required.
6. **Given** a CTO execution wave completes or partially fails, **When** results are summarized, **Then** each outcome maps back to its specification requirements and tasks, failures remain isolated, and CTO mode does not rewrite specification approvals.

---

### User Story 9 - Prepare specifications through CTO mode (Priority: P3)

As a user with several independent feature ideas or a broad initiative, I want CTO mode to coordinate specification preparation and return the resulting documents for my review, so research and drafting can proceed in parallel without creating a separate specification system.

**Why this priority**: This is useful for portfolios of work, but it must reuse the standard specification workflow and preserve human approval rather than adding a second CTO-specific format or autonomous approval path.

**Independent Test**: Ask CTO mode to prepare two independent specifications and one multi-facet specification, then verify that it creates standard feature workspaces, parallelizes only independent preparation, presents per-specification checkpoints to the user, and starts no implementation after final approval without a new explicit request.

**Acceptance Scenarios**:

1. **Given** several independent feature requests, **When** CTO mode prepares specifications, **Then** each request receives a distinct feature workspace and standard specification workflow; facets of the same feature remain in one workspace with coordinated contributors.
2. **Given** CTO-coordinated preparation, **When** phase artifacts are produced, **Then** they use the same templates, selected language, validation rules, traceability, and durable state as directly invoked specification work.
3. **Given** one or more prepared phase artifacts reach checkpoints, **When** CTO mode asks for review, **Then** it presents a readable review packet and records an explicit user decision for every specification and phase; neither CTO nor a team lead can approve on the user's behalf.
4. **Given** the user approves some specifications and requests changes to others, **When** preparation resumes, **Then** only eligible specifications advance while revisions remain on their affected phase and re-enter validation.
5. **Given** the Tasks phase receives final human approval, **When** specification preparation completes, **Then** CTO mode returns implementation-ready handoffs and waits; implementation requires a separate explicit CTO execution request or wave.
6. **Given** a resident CTO run is already active, **When** new specification preparation is requested, **Then** it is folded into that single run when capacity and phase allow, or queued with a visible reason; a nested CTO is never created.
7. **Given** one specification preparation slice fails or blocks, **When** other slices complete, **Then** completed specifications remain reviewable and the failed slice retains enough durable state for targeted resume.

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
- The same specification is selected concurrently by `/do-work` and CTO mode, or by two CTO runs.
- A specification changes after CTO plan confirmation but before or during execution.
- Multiple specifications contain cross-feature dependencies, shared-file ownership, incompatible architecture decisions, or competing migration order.
- A CTO run has reached its team cap, decomposition-depth cap, or integration phase when another specification is submitted.
- A batched CTO review contains a mixture of approve-and-continue, request-changes, and approve-and-stop decisions.
- Parallel specification preparation requests normalize to the same feature identity or target the same workspace.
- CTO-coordinated specifications use different document languages while sharing an architecture contract.
- A selected feature workspace belongs to another repository, resolves outside the authorized project root, or contains untrusted links.
- A hard-human security, production, destructive, or migration decision appears inside a batched CTO review.
- A CTO result attempts to mark specification approval, validation, or task completion without the corresponding specification-bound evidence.
- A specification's required branch or worktree strategy conflicts with the active CTO run.
- An external framework marks tasks complete or approved but provides no attributable evidence accepted by this plugin.
- An external change bundle contains only deltas and references a missing or incompatible baseline specification.
- Several external frameworks or candidate document sets exist in the same directory and automatic detection is ambiguous.
- An external bundle has requirements and design but no executable task graph, or tasks have duplicate or unstable identifiers.
- External documents change between discovery, compatibility approval, CTO plan confirmation, and implementation dispatch.
- A generic Markdown bundle mixes languages, terminology, generated code, implementation progress, and unresolved decisions.
- External documents reference remote files, symlinks, binaries, oversized content, or paths outside the authorized project root.
- External text contains prompt-injection instructions, secrets, executable snippets, or claims that conflict with repository evidence.
- A compatibility supplement drifts from or contradicts the external source on a later import.
- The source framework is upgraded and its artifact layout changes while an imported handoff is resumable.

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
- **FR-021**: A native feature MUST be marked implementation-ready only when Specify, Plan, and Tasks are current, pass validation, and carry explicit human approval; imported specifications MUST satisfy the equivalent compatibility requirements in FR-054–FR-070.
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
- **FR-033**: The final handoff MUST summarize approved scope, decisions, task order, validation status, open risks, selected language, supported execution choices, and the exact next user action in human-readable form.
- **FR-034**: The implementation handoff MUST be executor-neutral so the user can explicitly select `/do-work` or CTO mode without changing the approved specification format or meaning.
- **FR-035**: CTO mode MUST accept an explicit selection of one or more implementation-ready feature workspaces as input to a run or wave.
- **FR-036**: Before CTO dispatch, every selected workspace MUST pass preflight for identity, current artifact versions, required approvals, validation, constitution compliance, dependencies, project boundary, and conflicting execution ownership.
- **FR-037**: CTO plan confirmation MUST bind execution to exact approved artifact versions; a later semantic change MUST pause affected work and require revalidation and re-planning rather than silently changing the running contract.
- **FR-038**: The CTO team plan MUST map every selected specification task to its originating requirements, assigned slice, team ownership, dependencies, and completion evidence.
- **FR-039**: CTO mode MUST parallelize only slices whose dependency, ownership, worktree, and shared-contract constraints permit concurrent execution.
- **FR-040**: Shared interfaces, migrations, destructive steps, and cross-specification dependencies MUST receive an approved common contract or explicit serial order before implementation dispatch.
- **FR-041**: The user MUST explicitly confirm the specification-to-team mapping and parallelization plan before CTO mode starts implementation workers.
- **FR-042**: CTO support MUST retain the single resident main-session CTO and existing CTO → lead → worker hierarchy; it MUST NOT spawn a nested CTO to prepare or execute specifications.
- **FR-043**: A specification version MUST have at most one active execution owner; concurrent `/do-work` and CTO execution attempts MUST fail closed or queue without duplicate work.
- **FR-044**: CTO execution results MUST preserve per-specification traceability and failure isolation and MUST NOT mutate human approvals or validation outcomes.
- **FR-045**: CTO mode MUST be able to accept a specification-preparation request and coordinate the standard specification workflow as one or more bounded SPEC slices.
- **FR-046**: Parallel specification preparation MUST use distinct feature identities and workspaces; multiple contributors to the same feature MUST converge into one standard workspace rather than competing documents.
- **FR-047**: CTO-coordinated preparation MUST use the same templates, language resolution, validation, checkpoints, artifact versions, and implementation handoff as direct preparation.
- **FR-048**: CTO and team leads MUST NOT authorize human checkpoints; CTO mode MUST fan in completed phase artifacts and obtain an explicit user decision for each specification and phase.
- **FR-049**: A batched review MUST preserve per-specification decisions so approving one artifact never implies approval of another.
- **FR-050**: Completing specification preparation through CTO mode MUST NOT start implementation automatically; execution requires a separate explicit request and a new or amended execution wave.
- **FR-051**: CTO-coordinated preparation MUST isolate blocked or failed specifications while allowing independent completed specifications to reach user review and preserving resumable state for failures.
- **FR-052**: Requests that exceed CTO team, depth, ownership, or active-phase limits MUST be queued or split with a visible reason rather than silently dropped or forced into the active wave.
- **FR-053**: CTO support MUST reuse the shared implementation handoff and specification workflow contracts and MUST NOT introduce a CTO-specific specification format, duplicate state machine, or alternate approval semantics.
- **FR-054**: The system MUST accept an explicitly selected external specification bundle from an authorized local project path without requiring the source framework to be installed.
- **FR-055**: External intake MUST discover candidate requirements, plan, task, decision, and validation artifacts read-only and MUST require user selection when multiple interpretations are plausible.
- **FR-056**: Every import MUST record detected or declared framework, source paths, source revision when available, content fingerprints, document language, and provenance for the exact files used.
- **FR-057**: External documents MUST be treated as untrusted data: embedded instructions MUST NOT execute, paths and links MUST be bounded to authorized roots, and secrets or unsafe content MUST be redacted or rejected before rendering or delegation.
- **FR-058**: External intake MUST normalize source content into one versioned, framework-neutral import snapshot and the same executor-neutral implementation handoff used by native specifications, without creating another workflow state machine.
- **FR-059**: The system MUST produce a readable compatibility report that maps each source artifact to normalized scope, requirements, decisions, tasks, dependencies, verification evidence, assumptions, and unresolved gaps.
- **FR-060**: Compatibility validation MUST require bounded scope, testable requirements and acceptance outcomes, relevant constraints and decisions, an executable task graph with dependencies, verification expectations, and explicit unresolved decisions; requirements irrelevant to the selected task MUST be identified rather than silently discarded.
- **FR-061**: Compatibility validation MUST classify the result as ready, supplement-required, blocked, or unsupported and MUST explain every non-ready result with actionable findings.
- **FR-062**: A ready external bundle MUST be able to reach implementation after one explicit compatibility checkpoint without re-running internal Specify, Plan, and Tasks phases.
- **FR-063**: Approval or completion metadata from an external framework MAY be preserved as provenance but MUST NOT authorize implementation without an explicit current-user compatibility decision in this plugin.
- **FR-064**: A compatibility supplement MUST contain only missing or conflicting information required for readiness, remain readable and separately attributable, and MUST NOT rewrite or impersonate the external source.
- **FR-065**: An approved imported handoff MUST bind the external snapshot and any supplement into one frozen version; any subsequent source or supplement change MUST mark it stale and require impact review and renewed approval.
- **FR-066**: Re-importing unchanged sources with the same user selections MUST be idempotent and MUST return the established snapshot, compatibility result, and approval state without duplicate workspaces or handoffs.
- **FR-067**: Recognized framework conventions MAY improve automatic artifact discovery and mapping, but an unknown framework with readable documents MUST have a generic conformance path, and format recognition MUST NOT weaken workflow gates or approval semantics.
- **FR-068**: `/do-work` MUST be able to consume one approved imported handoff, and CTO mode MUST be able to consume one or more approved imported handoffs through the same execution claims, preflight, traceability, and fail-closed rules as native specifications.
- **FR-069**: External source files MUST remain unchanged during import and execution; local supplements, workflow state, progress, and results MUST be stored separately, and external-framework write-back or export is outside this feature.
- **FR-070**: The user MUST be able to inspect the supported-format and conformance result, including which framework-specific mapping was used, which artifacts were ignored, and whether generic intake remains available.
- **FR-071**: Every content-producing Specify, Plan, and Tasks stage, including a full specification workflow nested from `/do-work`, MUST execute through a declared subagent dispatch; the main session MAY coordinate, validate, materialize a worker's typed result, and present checkpoints, but MUST NOT author phase content.
- **FR-072**: Phase validation and review MUST finish as a blocking part of the active phase before its human checkpoint; detached or asynchronous reviewers MUST NOT alter the verdict, authorize a checkpoint, or advance the workflow after the checkpoint is presented.
- **FR-073**: Before any flow can enter native Specify or external compatibility validation, the system MUST check for a usable project constitution and MUST treat a missing, empty, structurally invalid, or unresolved-template document as unusable; if the check fails, it MUST invoke the canonical constitution workflow as a blocking prerequisite and MUST NOT continue the originating flow until that workflow returns an approved constitution. Warnings or version differences that do not violate mandatory structure MUST NOT force reapproval by themselves.
- **FR-074**: A generated-constitution checkpoint MUST offer exactly approve and continue or request changes; approval MUST be attributable and immediately resume the originating flow, while requested changes MUST revise and revalidate the same draft before repeating the checkpoint.
- **FR-075**: The constitution gate MUST apply to explicitly invoked native specification preparation, a full native workflow nested from `/do-work`, CTO-coordinated specification preparation, and external specification intake; after approval it MUST resume the exact originating entry point, entering Specify for native flows or compatibility validation for external intake.
- **FR-076**: Specification preparation and external intake MUST reuse the canonical constitution workflow's generation, validation, revision, approval, and persistence contracts; they MUST NOT implement a second constitution generator, writer, checkpoint state machine, or approval path.
- **FR-077**: Every phase validation, phase approval, compatibility decision, and implementation handoff MUST record the exact project constitution version and content fingerprint against which it was evaluated.
- **FR-078**: When the constitution changes, the workflow MUST perform semantic impact analysis, mark only affected specification artifacts and handoffs stale, and block their use until revalidated and reapproved; artifacts with recorded no-impact evidence MUST retain approval, and non-semantic file changes MUST NOT invalidate them.

### Requirement Acceptance Map

| Requirements | Acceptance evidence |
| --- | --- |
| FR-001–FR-005 | User Story 1 scenarios 6 and 9; User Story 6 scenario 3 |
| FR-006–FR-009 | User Story 1 scenarios 6–8; User Story 3 scenario 1 |
| FR-010–FR-017 | User Story 2 scenarios 1–5 |
| FR-018–FR-020 | User Story 6 scenarios 1–4 |
| FR-021–FR-025 | User Story 3 scenarios 1–4; User Story 4 scenarios 2–6 |
| FR-026–FR-028 | User Story 5 scenarios 1–4 |
| FR-029 | Concurrent-session, duplicate-feature, and duplicate-nested-run edge cases |
| FR-030 | User Story 7 scenarios 1–3 |
| FR-031 | User Story 6 scenario 3 plus constitution-compliance validation |
| FR-032–FR-033 | User Story 3 scenarios 1–4; User Story 4 scenarios 2–6; SC-010 |
| FR-034–FR-044 | User Story 8 scenarios 1–6 |
| FR-045–FR-053 | User Story 9 scenarios 1–7; User Story 8 scenarios 4–6 |
| FR-054–FR-070 | User Story 4 scenarios 1–8 |
| FR-071–FR-072 | User Story 1 scenarios 6–8; User Story 2 scenarios 1–3; User Story 5 scenarios 3–4 |
| FR-073–FR-076 | User Story 1 scenarios 1–5; User Story 4 scenario 9; SC-020 |
| FR-077–FR-078 | User Story 2 scenario 6; SC-021 |

### Key Entities

- **Feature Workspace**: The durable, discoverable home for one feature's readable documents, language choice, current phase, validation summaries, and implementation handoff.
- **Phase Artifact**: A versioned human-readable output for Specify, Plan, or Tasks, including provenance and the upstream artifact versions it depends on.
- **Template Set**: The mandatory structure and guidance used to create each phase artifact, with a resolved source and version.
- **Validation Result**: A phase-specific set of passed and failed quality criteria, actionable findings, artifact version, and timestamp.
- **Checkpoint Decision**: An attributable user choice to approve and continue, request changes, or approve and stop, bound to one validated artifact version.
- **Traceability Link**: A relationship connecting a requirement to acceptance scenarios, plan decisions, tasks, and verification evidence.
- **Implementation Handoff**: The current approved, executor-neutral contract that allows `/do-work` or CTO mode to begin implementation without repeating specification work.
- **Constitution Binding**: The project constitution version and content fingerprint used for a validation, approval, compatibility decision, or implementation handoff, plus any later semantic impact result.
- **Language Preference**: The selected document language, its source, and the artifact versions to which it applies.
- **Legacy Specification Run**: Existing JSON-only or prior-format state that may be migrated but is never assumed approved merely because it completed under an older workflow.
- **Execution Claim**: A durable, exclusive binding between one approved specification version and its active executor, preventing duplicate `/do-work` or CTO execution.
- **CTO Specification Mapping**: The reviewed mapping from specification requirements and tasks to CTO teams, slices, dependencies, worktree strategy, and completion evidence.
- **CTO Review Packet**: A readable fan-in of one or more phase artifacts with separate checkpoint decisions for every specification and phase.
- **External Specification Bundle**: An explicitly selected, read-only set of artifacts produced outside this workflow and considered together for compatibility validation.
- **Import Snapshot**: A framework-neutral, fingerprinted normalization of the exact external source versions used to construct an implementation handoff.
- **Compatibility Report**: The readable mapping from external artifacts to required implementation-contract concepts, including readiness status, ignored content, warnings, and blocking gaps.
- **Compatibility Supplement**: A local, attributable document containing only information required to close gaps in an external bundle without changing the original source.
- **Format Recognition Result**: The declared or detected external convention, confidence, selected source artifacts, ignored candidates, and whether generic intake was used.

### Reference-Informed Product Direction

- Adopt Spec Kit's explicit Specify → Plan → Tasks progression, stable templates, and feature-scoped document organization.
- Adopt OpenSpec's readable change workspace, brownfield orientation, editable artifacts, explicit verification, and preserved history rather than treating a completed document as disposable.
- Adopt Superpowers' practice of presenting reviewable chunks and requiring sign-off before deeper planning or execution.
- Adopt XPowers' separation of planning, execution, review, and verification, with one canonical task handoff instead of parallel task sources.
- Adopt BMAD's right-sized process: simple work avoids ceremony, while ambiguous or high-risk work receives deeper collaborative planning.
- Keep the implementation handoff executor-neutral: CTO mode consumes or coordinates the same specification contract instead of creating a CTO-specific document hierarchy.
- Prioritize read-only execution of ready external specifications as the first interoperability slice; generation, write-back, and bidirectional synchronization can follow only if separately justified.
- Provide one consistent intake, validation, and approval experience across formats so framework recognition does not fragment user-visible workflow behavior.
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
- **SC-011**: In representative single- and multi-specification CTO runs, 100% of dispatched slices retain requirement and task traceability, all declared dependencies preserve their order, and every eligible independent slice can start without waiting for unrelated work.
- **SC-012**: In CTO-coordinated preparation tests, 100% of outputs use standard feature workspaces and checkpoints, every approval is attributable to the user, and zero implementations start solely because specification preparation completed.
- **SC-013**: Across concurrent executor, changed-version, ambiguous-workspace, team-cap, and cross-specification conflict scenarios, 100% of unsafe CTO dispatch attempts fail closed or queue with an actionable reason and produce no duplicate work.
- **SC-014**: Across representative Spec Kit, OpenSpec, BMAD, Superpowers/XPowers-style, and generic Markdown fixtures, 100% of complete external bundles produce traceable import snapshots and approved handoffs while their source files remain byte-for-byte unchanged.
- **SC-015**: Across incomplete, ambiguous, delta-only, unsupported, and hostile external bundles, 100% of blocking gaps are reported before implementation and zero unsafe bundles reach an executor.
- **SC-016**: 100% of approved imported handoffs become stale before further dispatch when any bound external source or compatibility supplement changes.
- **SC-017**: A user can select a complete external bundle, inspect its compatibility report, and reach the approval checkpoint in one intake invocation without repeating internal specification phases.
- **SC-018**: In direct and `/do-work`-nested specification runtime traces, 100% of phase-content outputs are attributable to declared subagent dispatches, every checkpoint is presented only after validation completes, and zero detached review result can mutate or advance the phase.
- **SC-019**: Across every native-preparation and external-intake entry point plus missing, empty, unresolved-template, structurally invalid, warning-only, and version-difference constitution fixtures, 100% of unusable constitutions block the originating flow until the generated draft is explicitly approved, while every usable constitution proceeds without reapproval; each approval resumes the originating entry point and each requested change returns to the same constitution checkpoint.
- **SC-020**: In 100% of starts with a missing or unusable constitution, the user sees one canonical constitution draft and checkpoint sequence, the originating flow remains blocked until approval, approval resumes that flow exactly once, and no duplicate constitution draft or approval is created.
- **SC-021**: Across semantic constitution amendments that affect none, some, or all approved artifacts plus formatting-only changes, 100% of affected specifications and handoffs become stale before use, 100% of unaffected artifacts retain approval with no-impact evidence, and zero formatting-only changes trigger reapproval.

## Assumptions

- The redesign will treat Markdown documents as the primary user-facing contract; compact machine-readable state remains acceptable for orchestration, validation, and idempotent resume.
- The preferred baseline workspace contains one readable document per phase and a readable status or handoff view; exact auxiliary filenames are finalized during planning as long as discoverability remains stable.
- Explicit phase commands and checkpoint-driven continuation coexist: users may invoke each phase manually, while approve-and-continue provides a deliberate convenience path.
- Human approval is required at all three phase boundaries for the full workflow; autonomous implementation does not imply autonomous specification approval.
- Direct and `/do-work`-nested specification drafting is always delegated to declared subagents. The main session remains a coordinator for durable control, deterministic materialization, validation, and synchronous human checkpoints; it does not become the specification author or host detached review work.
- The workflow checks for a usable project constitution before entering native Specify or external compatibility validation. When none exists, it invokes the canonical constitution workflow as the blocking prerequisite defined by FR-073–FR-076; once approved, the constitution remains authoritative and every template and validation profile includes an explicit constitution-compliance check.
- Approved native and imported artifacts remain bound to the exact constitution version and fingerprint used for validation; later constitution changes follow the targeted stale-impact rules in FR-077–FR-078 rather than unconditional invalidation.
- Existing workflow owners and command-registration boundaries remain in force; this feature changes the specification experience and shared execution handoff, not ownership semantics.
- Research of Spec Kit, OpenSpec, Superpowers, XPowers, and BMAD informs planning, but the plugin keeps its own domain-agnostic, durable workflow engine rather than embedding another framework.
- Bug-fix, emergency, research-only, and product-discovery workflows are outside this feature except where they intentionally invoke or consume the shared specification handoff contract.
- CTO support is deliberately contract-level: CTO mode may consume ready handoffs or coordinate the standard specification workflow, but ownership, escalation transport, team caps, decomposition depth, and the single-resident-CTO model remain unchanged.
- The initial CTO support scope is one authorized repository and its worktrees; cross-repository specification stores and distributed execution are deferred.
- CTO and leads remain coordinators that write only authorized workflow state and declared artifacts; specification documents are produced through the standard phase workers into their declared feature workspaces.
- Read-only intake and implementation of ready external specifications is the preferred first delivery slice because it reuses validation, handoff, `/do-work`, and CTO execution contracts without depending on the new generation experience.
- The external bundle remains immutable source evidence; the import snapshot and any local supplement form this plugin's execution contract and never claim to replace the source framework's own state.
- Initial interoperability covers authorized local text artifacts. Remote fetching, binary document extraction, external-framework installation, write-back, export, and bidirectional synchronization are out of scope.
- Spec Kit, OpenSpec, BMAD, Superpowers, and XPowers are compatibility fixtures and design references, not core dependencies; unknown frameworks remain eligible through generic conformance validation.
