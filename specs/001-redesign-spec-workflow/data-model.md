# Data Model: Readable Specification Workflow

## Storage Boundaries

The model extends the existing `TeamState`; it does not introduce a second state machine.

- `specs/<feature-id>/` is the human-readable current workspace and readable revision history.
- `.work-state/features/<feature-id>/state.json` is the canonical aggregate state.
- `.work-state/features/<feature-id>/artifacts/*.json` contains immutable, versioned typed artifacts returned by subagents and derived engine records.
- Trusted checkpoint answers retain the current engine-owned answer ledger and capability binding.
- External source files are never part of the writable workspace.

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
| `constitution` | per-principle result | Required for every phase; full re-check required after Plan. |
| `traceability_summary` | counts/missing ids | Required after Plan and Tasks. |
| `validator_version` | string/hash | Makes revalidation deterministic and attributable. |

Checks cover required semantic markers, unresolved clarifications, contradictions, scope, traceability, stale upstreams, template/language binding, constitution compliance, safe paths, and phase-specific readiness.

### CheckpointDecision

The existing typed checkpoint record is reused. Specification rules add exactly three allowed decision values:

- `approve_continue`
- `request_changes`
- `approve_stop`

The decision remains bound to run, stage, checkpoint, work identity, capability id/epoch, policy hash, user actor, and trusted terminal/escalation answer proof. For `request_changes`, the rationale contains non-empty revision feedback. Agent, CTO, lead, and policy-auto actors cannot authorize these checkpoints.

### TraceabilityLink

| Field | Type | Rules |
| --- | --- | --- |
| `requirement_id` | string | Stable id from the approved specification or normalized external source. |
| `acceptance_ids` | string array | At least one per functional requirement. |
| `decision_ids` | string array | At least one relevant Plan decision before readiness. |
| `task_ids` | string array | At least one before readiness. |
| `verification_ids` | string array | At least one expected evidence item before readiness. |
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
| `verification` | evidence contracts | Covers all required tasks and requirements. |
| `validation_refs` / `approval_refs` | id arrays | All current, passing, and human-authorized. |
| `language` / `constitution_status` | metadata | Visible to executors and reviewers. |
| `risks` / `open_decisions` | arrays | Open blocking decisions must be empty when ready. |
| `execution_choices` | executor enum array | `do-work`, `cto`, or both. |
| `status` | `candidate \| ready \| stale` | Derived from current bindings. |

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
created -> in_progress -> implementation_ready -> claimed -> executing -> completed
                  |                |              |
                  v                v              v
               blocked           stale          blocked
```

- `implementation_ready` is derived from the handoff readiness predicate.
- Imported workspaces reach the same status through compatibility approval rather than native phase approval.
- Any changed bound artifact moves `implementation_ready`, `claimed`, or `executing` to `stale`/`blocked` before new dispatch.

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
(unclaimed) -> active -> completed
                     -> released
                     -> blocked    (handoff changed or owner cannot continue)
```

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
