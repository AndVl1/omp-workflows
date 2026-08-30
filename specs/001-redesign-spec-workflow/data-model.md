# Data Model: Readable Specification Workflow

## Storage Boundaries

The model extends the existing `TeamState`; it does not introduce a second state machine.

- `specs/<feature-id>/` is the human-readable current workspace and readable revision history.
- `.work-state/features/<feature-id>/state.json` is the canonical aggregate state.
- `.work-state/features/<feature-id>/artifacts/*.json` contains immutable, versioned typed artifacts returned by subagents and derived engine records.
- Trusted checkpoint answers retain the current engine-owned answer ledger and capability binding.
- External specification bundle source files are never part of the writable workspace; a separately selected constitution provider path is project policy, not an imported specification source.
- The resolved `ConstitutionProviderSelection` owns one human-readable project policy: explicit override, exactly one discovered existing provider, or the native root `CONSTITUTION.md` default. Spec Kit is only an optional file-layout provider.

## Entities

### FeatureWorkspace

The stable aggregate for one native, imported, or migrated feature.

| Field | Type | Rules |
| --- | --- | --- |
| `schema_version` | integer | Migrated through the existing fail-closed migration receipt path. |
| `feature_id` | string | Immutable, safe path segment, unique in the authorized project, independent of branch. |
| `display_name` | string | Human-readable; does not determine identity. |
| `source_kind` | `native \| external \| legacy` | Selects provenance and readiness requirements, not a separate state machine. |
| `project_root` | absolute path | Resolved and realpath-bounded to the authorized project. |
| `workspace_path` | project-relative path | Exactly `specs/<feature-id>` for the default resolver. |
| `state_path` | project-relative path | Exactly `.work-state/features/<feature-id>/state.json`. |
| `profile_name` / `profile_hash` | string | Bind the aggregate to the active declarative profile version. |
| `constitution_gate_ref` | artifact id or null | Required before native Specify generation or external compatibility validation. |
| `constitution_binding` | `ConstitutionBinding` or null | Current approved/usable constitution bound to this workspace; null only while the prerequisite is unresolved. |
| `language` | `LanguageSelection` | Required for every generated readable artifact. |
| `template_set` | `TemplateSelection` | Required for native and migrated rendering. |
| `phases` | three `PhaseRecord`s | Exactly Specify, Plan, and Tasks for native workspaces. Imported workspaces retain equivalent normalized records. |
| `status` | workspace status | Derived from phase/import readiness, never independently trusted. |
| `next_action` | typed action | Must identify a valid command/checkpoint/remediation or `none`. |
| `handoff_ref` | artifact id or null | Non-null only when a current candidate/ready handoff exists. |
| `execution_claim_ref` | claim id or null | Bound to the current ready handoff digest. |
| `import_ref` | snapshot id or null | Required when `source_kind=external`. |
| `migration_receipt_ref` | receipt id or null | Required when materialized from legacy state. |

Relationships:

- Owns exactly one current `PhaseRecord` per native phase.
- Owns many immutable `PhaseArtifactVersion`, `ValidationResult`, and `CheckpointDecision` records.
- Owns at most one current `ImplementationHandoff` and one active `ExecutionClaim`.
- Optionally owns one current `ImportSnapshot`, `CompatibilityReport`, and `CompatibilitySupplement`.
- References one current `ConstitutionGateRecord`; owns immutable constitution bindings and impact assessments relevant to its artifacts.

### ConstitutionProviderSelection

The immutable resolution result for the project policy location and template source.

| Field | Type | Rules |
| --- | --- | --- |
| `provider_id` | string | `native` for the shipped provider or a registered adapter id such as `speckit`; never inferred from document content alone. |
| `source` | `explicit_override \| discovered_provider \| native_default` | Enforces resolver precedence. |
| `path` | project-relative path | Realpath-bounded to the authorized project; defaults to `CONSTITUTION.md`. |
| `template_ref` / `template_hash` | reference / SHA-256 | Shipped framework-neutral template unless an explicitly selected provider supplies a valid override. |
| `selection_hash` | SHA-256 | Binds provider id, path, template, configuration, and discovery evidence. |
| `selected_at` | timestamp | Audit only. |

Resolution order is explicit project `constitution.path`, exactly one discovered registered
provider, then the native default. Multiple existing provider candidates are `blocked`; the engine
must not choose by load order, filename preference, or framework detection confidence. Provider
discovery is local metadata/file inspection and never invokes a command, CLI, or remote service.


### ConstitutionGateRecord

The durable prerequisite record shared by native preparation and external intake. It coordinates the
canonical constitution workflow but does not author or persist constitution content itself.

| Field | Type | Rules |
| --- | --- | --- |
| `gate_id` | string | Idempotency key derived from project, originating run, entry point, and capability epoch. |
| `origin_kind` | `native_direct \| do_work_nested \| cto_preparation \| external_import` | Determines the exact resume target. |
| `origin_run_key` / `origin_stage` | engine identity | Must resolve to the still-current originating cursor before resume. |
| `status` | `checking \| usable \| constitution_required \| awaiting_approval \| approved \| blocked` | Uses the transition table below. |
| `usability_result` | typed result | Records missing, empty, unresolved-template, structurally-invalid, or usable plus warnings. |
| `provider` | `ConstitutionProviderSelection` or null | Required before usability validation or generation. |
| `constitution_workflow_ref` | run/artifact reference or null | Required when the plugin-native `constitution.json` workflow is invoked. |
| `checkpoint_ref` | checkpoint id or null | Required only when a generated or corrected constitution is approved. |
| `binding` | `ConstitutionBinding` or null | Required before the originating flow can resume. |
| `resume_marker` | dispatch/idempotency marker | Consumed exactly once; replay returns the established continuation result. |

An already usable constitution transitions directly to `usable` and opens no checkpoint. A required
bootstrap dispatches a declared subagent for typed draft semantics; the engine materializes through
the selected provider and performs authoritative validation. Its checkpoint allows only
`approve_continue` or `request_changes`; the three-decision phase checkpoint contract does not
apply.

### ConstitutionBinding

| Field | Type | Rules |
| --- | --- | --- |
| `provider_id` | string | Must match the immutable `ConstitutionProviderSelection` used to resolve the path. |
| `path` | project-relative path | Canonical policy path, realpath-bounded to the authorized project. |
| `version` | semantic version string | Parsed from the validated constitution; never trusted without the fingerprint. |
| `content_sha256` | SHA-256 | Exact bytes used for validation or approval. |
| `semantic_hash` | SHA-256 | Hash of normalized policy sections used only for impact comparison. |
| `validation_ref` | artifact id | Proves mandatory structure and unresolved-template checks passed. |
| `bound_at` | timestamp | Audit only; excluded from content hashes. |

The binding is embedded in every phase validation, phase approval, compatibility decision, and
implementation handoff. A version label alone never establishes identity.

### ConstitutionImpactAssessment

| Field | Type | Rules |
| --- | --- | --- |
| `assessment_id` | string | Immutable and idempotent for old/new content fingerprints plus evaluator version. |
| `previous_binding` / `current_binding` | `ConstitutionBinding` | Exact compared policy versions. |
| `evaluator_version` | string/hash | Makes the assessment reproducible and attributable. |
| `artifact_results` | artifact → result array | Every previously approved bound artifact is `affected` or `no_impact`; no omission is treated as current. |
| `evidence` | section/rule/dependency references | Required for both affected and no-impact outcomes. |
| `status` | `pass \| blocked` | `blocked` when impact cannot be established safely. |

`affected` marks only that artifact and its dependants stale. `no_impact` preserves approval while
recording the new binding and evidence. A formatting-only change is no-impact only when stable
semantic-section hashes prove equivalence; otherwise the assessment fails closed.

### LanguageSelection

| Field | Type | Rules |
| --- | --- | --- |
| `language` | BCP-47-like string | Human prose language; technical identifiers and quoted evidence may remain unchanged. |
| `source` | `feature_override \| project_default \| request_language` | Enforces the specified precedence. |
| `selected_at` | timestamp | Audit only. |
| `selection_hash` | SHA-256 | Bound into every affected phase version. |

Changing the selection creates new phase versions and invalidates affected approvals.

### TemplateSelection

| Field | Type | Rules |
| --- | --- | --- |
| `template_set_id` | string | Stable logical id. |
| `source` | `feature_override \| project_default \| shipped_default` | Enforces resolver precedence. |
| `phase_templates` | phase → template ref | Exactly one template for each generated phase. |
| `content_hash` | SHA-256 | Bound to phase versions and validation. |
| `required_markers` | string array | Stable semantic markers independent of localized heading text. |

A template missing a mandatory marker is invalid before worker dispatch.

### PhaseRecord

One aggregate record for `specify`, `plan`, or `tasks`.

| Field | Type | Rules |
| --- | --- | --- |
| `phase` | phase enum | Immutable. |
| `status` | phase status | Uses the transition table below. |
| `current_version` | positive integer or null | Points to an immutable `PhaseArtifactVersion`. |
| `approved_version` | positive integer or null | Must equal `current_version` for a current approval. |
| `validation_ref` | artifact id or null | Required before `awaiting_approval` or `approved`. |
| `checkpoint_ref` | checkpoint id or null | Required when approved. |
| `upstream_versions` | version bindings | Empty for Specify; Specify for Plan; Specify and Plan for Tasks. |
| `stale_reason` | typed reason or null | Required when `status=stale`. |
| `last_feedback` | string or null | Captured only from `request_changes`; supplied to the next phase worker. |

No `review_pending` or detached-review status exists. Validation is part of the active phase and finishes before `awaiting_approval`.

### PhaseArtifactVersion

Immutable content/provenance for one phase revision.

| Field | Type | Rules |
| --- | --- | --- |
| `artifact_id` | string | Versioned id such as `specify.v2`; never overwritten. |
| `phase` / `version` | enum / integer | Unique within the workspace. |
| `dispatch_id` / `work_identity` | typed engine identity | Proves which subagent dispatch produced the content. |
| `source_artifact_hash` | SHA-256 | Hash of canonical typed worker output. |
| `document_paths` | project-relative path array | All paths must remain inside the feature workspace. |
| `document_hashes` | path → SHA-256 | Detects manual edits or materialization drift. |
| `semantic_section_hashes` | marker → SHA-256 | Supports explicit presentation-only impact evidence. |
| `template_hash` / `language_hash` | SHA-256 | Required for generated documents. |
| `upstream_versions` | version bindings | Exact artifact id, version, and hash for every dependency. |
| `created_at` | timestamp | Audit only; not included in deterministic content hashes. |
| `constitution_binding` | `ConstitutionBinding` | Exact policy version and content fingerprint used to create/validate this phase version. |

On replacement, the previous readable projection moves to `history/<phase>/v<version>.md` before the new projection becomes current.

### ValidationResult

Readable and machine-readable phase validation bound to one artifact version.

| Field | Type | Rules |
| --- | --- | --- |
| `validation_id` | string | Immutable. |
| `phase` / `artifact_version` | binding | Must match the current artifact to authorize a checkpoint. |
| `status` | `pass \| fail` | Only `pass` permits `awaiting_approval`. |
| `checks` | check result array | Includes criterion id, status, evidence, and actionable remediation. |
| `blocking_findings` | finding array | Empty when status is `pass`. |
| `warnings` | finding array | Non-blocking and visible. |
| `constitution` | per-principle result plus `ConstitutionBinding` | Required for every phase; full re-check required after Plan. |
| `traceability_summary` | counts/missing ids | Required after Plan and Tasks. |
| `validator_version` | string/hash | Makes revalidation deterministic and attributable. |

Checks cover required semantic markers, unresolved clarifications, contradictions, scope, traceability, stale upstreams, template/language binding, constitution compliance, safe paths, and phase-specific readiness.

### CheckpointDecision

The existing typed checkpoint record is reused. Specification rules add exactly three allowed decision values:

- `approve_continue`
- `request_changes`
- `approve_stop`

The decision remains bound to run, stage, checkpoint, work identity, capability id/epoch, policy hash, user actor, trusted terminal/escalation answer proof, and the exact `ConstitutionBinding`. For `request_changes`, the rationale contains non-empty revision feedback. Agent, CTO, lead, and policy-auto actors cannot authorize these checkpoints.

### TraceabilityLink

| Field | Type | Rules |
| --- | --- | --- |
| `requirement_id` | string | Stable id from the approved specification or normalized external source. |
| `acceptance_ids` | string array | At least one per functional requirement. |
| `decision_ids` | string array | At least one relevant Plan decision before readiness. |
| `task_ids` | string array | At least one before readiness. |
| `verification_ids` | string array | At least one pre-implementation obligation before readiness; each obligation identifies covered acceptance scenarios and whether it proves observable behavior. |
| `source_refs` | path/anchor array | Required for imported material and supplements. |

A native handoff is not ready while any required link is incomplete or stale.

### ImplementationTask

The normalized canonical task node used by both executors.

| Field | Type | Rules |
| --- | --- | --- |
| `task_id` | string | Unique and stable within the handoff. |
| `title` | string | Outcome-oriented. |
| `requirement_ids` | string array | Non-empty. |
| `depends_on` | task id array | No self-reference, dangling id, or cycle. |
| `expected_outcome` | string | Observable result. |
| `affected_scope` | path/symbol/surface array | Concrete and bounded. |
| `completion_evidence` | evidence contract array | Non-empty and executable. |
| `parallel_safe` | boolean | True only when dependency, ownership, shared-contract, migration, and worktree checks allow it. |

`tasks.md` and the handoff task graph are the only canonical implementation task source. CTO team slices map to these ids; they do not create a competing task list.

### ImplementationHandoff

Frozen executor-neutral implementation contract.

| Field | Type | Rules |
| --- | --- | --- |
| `handoff_id` / `handoff_digest` | string / SHA-256 | Immutable and content-addressed. |
| `feature_id` / `source_kind` | binding | Identifies the workspace and provenance path. |
| `artifact_versions` | phase/import bindings | Exact approved versions and hashes. |
| `scope` / `requirements` / `decisions` | normalized content | Must be complete and conflict-free. |
| `tasks` | `ImplementationTask[]` | Valid acyclic task graph. |
| `verification` | evidence obligations | Covers all required tasks, requirements, and acceptance scenarios; each item declares `observable_behavior` so terminal conformance knows when passing executed-test evidence is mandatory. |
| `validation_refs` / `approval_refs` | id arrays | All current, passing, and human-authorized. |
| `constitution_binding` / `constitution_impact_ref` | metadata / artifact id or null | Exact approved policy fingerprint and any later no-impact evidence; an affected or unassessed change makes the handoff non-ready. |
| `risks` / `open_decisions` | arrays | Open blocking decisions must be empty when ready. |
| `execution_choices` | executor enum array | `do-work`, `cto`, or both. |
| `status` | `candidate \| ready \| stale` | Derived from current bindings. |

### RequirementClosureEntry

One immutable matrix row for an approved requirement or acceptance scenario.

| Field | Type | Rules |
| --- | --- | --- |
| `entry_id` | string | Stable within the conformance result. |
| `subject_kind` | `requirement \| acceptance_scenario` | Both kinds are required in a complete matrix. |
| `subject_id` | string | Exact approved requirement or acceptance id from the handoff. |
| `requirement_id` | string | Self for a requirement row; owning requirement for an acceptance row. |
| `observable_behavior` | boolean | Copied from the frozen verification obligations, never inferred from submitted evidence. |
| `implementation_evidence_refs` | artifact ref array | Attributable, current, and bound to the execution claim/handoff; non-empty for `pass`, empty only when a blocking finding records missing evidence. |
| `review_verdict` | `pass \| fail \| missing` | A row cannot pass without `pass`. |
| `review_evidence_refs` | artifact ref array | Produced by the selected execution profile's review path; non-empty for `pass`, empty only with a blocking missing-review finding. |
| `test_evidence_refs` | executed evidence ref array | A passing observable row has at least one current passing executed test or runtime scenario; blocked rows may be empty to represent the missing evidence explicitly. |
| `status` | `pass \| blocked \| changed_intent` | Derived deterministically; never supplied as an override. |
| `findings` | finding array | Exact missing, failed, stale, contradictory, or intent-conflict evidence. |

### ImplementationConformanceResult

The executor-neutral requirement-closure matrix that gates terminal feature completion.

| Field | Type | Rules |
| --- | --- | --- |
| `conformance_id` / `matrix_digest` | string / SHA-256 | Immutable, content-addressed, and idempotent for the same inputs. |
| `feature_id` / `handoff_id` / `handoff_digest` | exact bindings | Must identify the current approved implementation contract. |
| `execution_claim_id` / `execution_owner` / `execution_run_id` | claim bindings | Evidence must belong to the active owner and run. |
| `profile_hash` | SHA-256 | Binds the quality-gate and review/test policy used. |
| `entries` | `RequirementClosureEntry[]` | Exactly one row for every approved requirement and every acceptance scenario; no extra or duplicate subjects. |
| `quality_gate_results` | gate result array | Every constitution- or selected-profile-mandated gate is present with current evidence; these rows cannot replace requirement closure. |
| `overall_status` | `pass \| blocked \| changed_intent` | `pass` only when every closure and quality-gate row passes. |
| `blocking_findings` | finding array | Empty only for `pass`; grouped by subject and evidence type. |
| `next_action` | typed action | Complete, repair implementation, repeat review/test, or revise the earliest affected specification phase. |
| `evaluated_at` | timestamp | Audit metadata; not freshness proof by itself. |

The engine derives the subject set from the handoff. Executors can submit evidence but cannot add,
remove, reinterpret, or waive rows. A human answer cannot override a non-passing result.

### ExecutionClaim

Exclusive ownership of one ready handoff version.

| Field | Type | Rules |
| --- | --- | --- |
| `claim_id` | string | Immutable. |
| `handoff_digest` | SHA-256 | Claim key. |
| `owner_kind` | `do_work \| cto` | Exactly one active owner kind. |
| `owner_run_id` | string | Existing execution run or CTO wave. |
| `status` | `active \| completed \| released \| blocked` | No automatic takeover of a live claim. |
| `acquired_at` / `updated_at` | timestamps | Audit and liveness diagnostics. |
| `release_reason` | string or null | Required for release/block. |

A claim becomes `completed` only after the bound `ImplementationConformanceResult` passes. Missing,
failed, stale, or contradictory evidence leaves the claim active for the current owner while it
repairs the same implementation. `changed_intent` blocks the claim and routes revision to the
earliest affected specification phase.

A changed handoff invalidates the claim for further dispatch. It does not silently transfer ownership.

### FormatRecognitionResult

| Field | Type | Rules |
| --- | --- | --- |
| `framework` | known id or `generic` | Recognition is advisory. |
| `confidence` | bounded enum/score | Low or ambiguous confidence requires user selection. |
| `selected_paths` | source path array | Realpath-bounded and explicitly reported. |
| `ignored_candidates` | path/reason array | Visible in the compatibility report. |
| `mapping_id` / `mapping_version` | string | Identifies the registered adapter or generic mapping. |

Recognition never changes gates or imports external approval.

### ImportSnapshot

Immutable normalization of exact external sources.

| Field | Type | Rules |
| --- | --- | --- |
| `snapshot_id` | string | Idempotency key derived from selections and source fingerprints. |
| `source_root` | authorized local path | Read-only; remote fetch is out of scope. |
| `recognition_ref` | recognition id | Required. |
| `files` | path/hash/size/media-type array | Safe text allowlist, bounded count/size, no escaping symlink. |
| `source_revision` | git revision or null | Per-file hashes remain authoritative. |
| `document_language` | string or unknown | Visible in report. |
| `redactions` | redaction records | Secrets are never copied into readable output. |
| `normalized_content_ref` | typed artifact id | Content is treated as data, not instructions. |

Re-import with identical selection and fingerprints returns the established snapshot and approval state.

### CompatibilityReport

| Field | Type | Rules |
| --- | --- | --- |
| `status` | `ready \| supplement_required \| blocked \| unsupported` | Drives the compatibility checkpoint. |
| `mapping` | source-to-contract links | Covers scope, requirements, decisions, tasks, dependencies, verification, assumptions, and gaps. |
| `blocking_findings` / `warnings` | finding arrays | Every non-ready status is actionable. |
| `ignored_content` | path/reason array | Required when candidates were not selected. |
| `supplement_ref` | artifact id or null | Present only when a local supplement is required/approved. |

External status, checkboxes, sprint state, or task completion may appear as provenance but cannot satisfy `approval_refs`.

### CompatibilitySupplement

A local, versioned document containing only missing or conflicting information needed for readiness. It binds the import snapshot, cites exact source paths/anchors, records current-user approval, and never alters or impersonates external source content.

### CtoSpecificationMapping

A versioned extension of the existing CTO team plan.

| Field | Type | Rules |
| --- | --- | --- |
| `mapping_id` | string | Frozen at plan confirmation. |
| `handoff_bindings` | feature/handoff digest array | Exact selected versions. |
| `task_to_slice` | task/team/dependency/evidence array | Complete coverage, no duplicate ownership. |
| `shared_contracts` | contract/owner/order array | Required for shared interfaces, migrations, and destructive work. |
| `parallelization` | slice decision array | Includes reason and worktree strategy. |
| `checkpoint_ref` | user confirmation | Required before implementation dispatch. |

### CtoReviewPacket

A rendering-only fan-in of phase artifacts. It contains a section per feature and phase, but each decision is stored through the corresponding workspace's typed checkpoint ledger. The packet itself cannot authorize or mutate approval.

## State Transitions

### Constitution Prerequisite State

```text
entry_requested
    -> checking
checking
    -> usable                  (current constitution passes mandatory checks; resume origin)
    -> constitution_required   (missing, empty, unresolved template, or structural failure)
constitution_required
    -> awaiting_approval       (canonical workflow generated/corrected and validated one draft)
awaiting_approval
    -> approved                (approve_continue; bind policy and resume origin exactly once)
    -> constitution_required   (request_changes; revise/revalidate the same draft identity)
approved
    -> usable                  (idempotent established result)
```

Warnings and version differences do not enter `constitution_required` when mandatory structure
passes. Native origins resume at Specify; external origins resume at compatibility validation.

### Phase State

```text
not_started
    -> generating                  (capability issued; subagent dispatched)
generating
    -> materialized                (typed result persisted; Markdown rendered)
    -> blocked                     (dispatch or schema failure)
materialized
    -> validating
validating
    -> awaiting_approval           (all mandatory checks pass)
    -> revision_required           (blocking findings)
awaiting_approval
    -> approved                    (approve_continue or approve_stop)
    -> revision_required           (request_changes with feedback)
revision_required
    -> generating                  (new capability epoch and version)
approved
    -> stale                       (bound source/template/language/upstream changes)
stale
    -> generating                  (explicit revision/resume)
blocked
    -> generating                  (prerequisite repaired and explicit resume)
```

`approve_continue` and `approve_stop` produce the same durable `approved` state. Only the coordinator behavior differs: continue dispatches the next phase immediately; stop returns with the next phase pending.

### Workspace Status

```text
created -> in_progress -> implementation_ready -> claimed -> executing
                                                        -> completion_validating -> completed
                                                                     |
                                                                     v
                                                            completion_blocked
                                                                     |
                                                                     +-> executing

implementation_ready | claimed | executing | completion_validating
                  -> stale | blocked

- `implementation_ready` is derived from the handoff readiness predicate.
- Imported workspaces reach the same status through compatibility approval rather than native phase approval.
- Any changed bound artifact moves `implementation_ready`, `claimed`, or `executing` to `stale`/`blocked` before new dispatch.
- If the current constitution fingerprint differs from a bound handoff, readiness remains blocked until a current impact assessment marks the handoff `no_impact` or targeted revalidation/reapproval produces a new handoff.
- `completion_validating` is entered only with the exact active claim and handoff digest.
- `completion_blocked` retains the active owner and exposes evidence remediation; a later idempotent evaluation may pass after new current evidence.
- `changed_intent` never enters `completion_blocked`; it marks the affected contract stale and routes to specification revision.
- `completed` requires a current passing `ImplementationConformanceResult`. Generic quality gates, task completion, team status, or human acknowledgement cannot produce it.

### Import Status

```text
discovered -> selection_required -> snapshotted -> validating
                                              -> ready
                                              -> supplement_required -> validating
                                              -> blocked
                                              -> unsupported
ready -> awaiting_compatibility_approval -> implementation_ready
```

### Execution Claim Status

```text
(unclaimed) -> active -> completed   (current conformance result passes)
                     -> released
                     -> blocked      (handoff changed, intent changed, or owner cannot continue)

Evidence-remediation failures leave the claim `active`; they do not release it for duplicate execution.

A second active owner receives a conflict or queue result and performs no dispatch.

## Aggregate Invariants

1. `feature_id`, workspace root, and state root are immutable after creation.
2. All state-changing tool calls bind the explicit run identity and current capability epoch; `.active-feature` cannot redirect them.
3. Phase content is attributable to a declared subagent dispatch. Engine rendering and validation cannot invent missing semantic content.
4. A checkpoint is impossible before a current passing `ValidationResult` exists.
5. A specification phase has exactly one current version and at most one approved current version.
6. Downstream approval references exact upstream versions; any unproven semantic change makes it stale.
7. Human approval requires the existing trusted answer proof and cannot be inferred from agent output, validation pass, external metadata, CTO state, or completion intent.
8. A ready handoff has complete requirement → acceptance → decision → task → verification traceability and no blocking open decision.
9. Only one active `ExecutionClaim` exists per handoff digest.
10. External sources remain byte-for-byte unchanged; import output, supplements, state, claims, and progress are stored separately.
11. CTO review packets are projections; every approval remains a separate feature-bound checkpoint decision.
12. No asynchronous review result can change validation, approval, current version, handoff readiness, or workflow cursor.
13. No native Specify generation or external compatibility validation begins without a current successful `ConstitutionGateRecord`.
14. Every validation, approval, compatibility decision, and handoff binds the exact constitution version and content fingerprint used.
15. A changed constitution preserves an approval only with explicit artifact-scoped `no_impact` evidence; unassessed or affected bindings fail closed and stale only their dependency closure.
16. Constitution generation works through the shipped profile/provider when no external framework is installed; provider adapters cannot invoke external commands or replace approval semantics.
17. More than one discovered constitution source blocks before usability validation, generation, or downstream dispatch until `constitution.path` selects one.
18. Every approved requirement and acceptance scenario appears exactly once in the final requirement-closure matrix.
19. Every closure row has attributable implementation evidence and a passing review verdict; every observable-behavior row also has current passing executed-test evidence.
20. A workspace and execution claim become completed only with a current passing conformance result bound to their exact handoff digest and active owner.
21. Constitution/profile quality gates are mandatory additional evidence but cannot close missing specification rows; no separate feature-specific DoD or human override can replace the matrix.
