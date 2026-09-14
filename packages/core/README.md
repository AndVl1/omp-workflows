# @andvl1/omp-workflows-core

Profile-driven multi-stage workflow engine for omp. No agents — bundles ship those.
Ships the `custom-agent-bundle` skill (how to add your own agents).

## Install

```bash
npm install @andvl1/omp-workflows-core
```

To expose the bundled skill to the agent (so it can help build a custom
bundle), install core as an omp plugin too:

```bash
omp plugin install @andvl1/omp-workflows-core
```

(The package carries an `omp: {}` manifest — skills are discovered without an
extension entry; see [`docs/adding-agents.md`](../docs/adding-agents.md).)

## Readable specification workflow

The core package provides the readable, constitution-first specification workflow. It has no agents and does not run framework CLIs or network calls; a bundle supplies agents and registers any consumer-specific adapters. The workflow is available at the exact public package version **0.27.0**.

### Direct phase commands

The commands are registered by `registerWorkflowCommands(...)` and are usable without a project-local copy:

```text
/specify [--feature <feature-id>] <request>
/spec-plan --feature <feature-id>
/spec-tasks --feature <feature-id>
/spec-import <path> [--framework <id|generic>] [--feature <feature-id>]
```

`/specify` creates or resumes the feature workspace and authors the Specify phase. `/spec-plan` consumes an approved Specify artifact; `/spec-tasks` consumes an approved Plan artifact. Each phase validates a typed, immutable draft before presenting its checkpoint. Supply `--feature` exactly once, at the start of the command; Plan and Tasks reject positional request text. For example:

```text
/specify --feature account-recovery Add account recovery with email verification
/spec-plan --feature account-recovery
/spec-tasks --feature account-recovery
```

Approval is a human authorization to advance that phase, not permission to implement code. The phase checkpoint accepts exactly `approve_continue`, `request_changes`, or `approve_stop`; `request_changes` reopens the same phase with feedback, and `approve_stop` ends preparation at that boundary.

### Constitution prerequisite and native files

Specify, external compatibility validation, nested `/do-work` preparation, and CTO preparation share the `ensure_project_constitution` prerequisite. A usable policy is bound by content hash. A missing or unusable policy blocks the origin and opens the separate constitution bootstrap checkpoint, which accepts only `approve_continue` or `request_changes`; no constitution approval is inferred from a phase approval. The bootstrap resumes the exact feature/run origin once its trusted human proof is recorded.

A native feature has one branch-independent identity: a safe explicit `<feature-id>` plus its durable `run_key`. Its readable projections live under `specs/<feature-id>/` (for example `spec.md`, `plan.md`, and `tasks.md`); typed state is authoritative at `.work-state/features/<feature-id>/state.json`, with immutable versioned artifacts and manifests below that feature's `artifacts/` directory. Branch names and `.active-feature` are provenance only and never select or replace a workspace.

The retired `dod_and_artifacts/CompletionDodStatus/dod_status` path and the old JSON-only specification flow are not inputs or outputs. Use the native workspace, typed artifacts, and readable projections above.

### External intake, language, and templates

`/spec-import` reads one authorized local path, captures an immutable snapshot and SHA-256, performs compatibility validation, and never modifies the source. It does not fetch URLs, invoke an external CLI, or use a network service. Register consumer seams with `registerFormatRecognizer(...)` for framework recognition and `registerConstitutionProvider(...)` for existing local policy discovery. An explicit `--framework <id>` selects one registered recognizer; `--framework generic` selects the framework-neutral path. Without a selector, multiple recognizer claims fail closed rather than guessing.

Presentation choices are deterministic and are bound into phase versions:

- Language: feature override, then project default, then request language.
- Template: feature override, then project default, then shipped default.

A present higher-precedence template is authoritative: invalid content fails closed instead of silently falling through. Changing the bound language or template set stales affected approvals so the phase is validated again.

Legacy JSON state can be migrated only through the explicit migration boundary used by the direct command. Migration is one-way and read-only over the legacy source: it requires an explicit safe feature id, non-blank run key, compatible Specify/Plan/Tasks stages and artifact paths, and the current constitution binding. A successful migration writes a receipt and resumes the first unapproved phase; incompatible or ambiguous state returns `SPEC_MIGRATION_BLOCKED` with diagnostics and no guessed identity.

### `/do-work`: adaptive preparation, execution, and conformance

Use `/do-work <task>` for normal implementation work (`/team <task>` remains its compatibility alias). Preparation is adaptive and never dispatches implementation work:

- `quick`: only clear, high-confidence, low-risk work; no nested specification identity is created.
- `bounded_specify`: medium work or unresolved scope; prepare and review a focused Specify boundary.
- `full_specification`: complex/critical, low-confidence, security-sensitive, or infrastructure-sensitive work; complete constitution-first Specify → Plan → Tasks.

The rationale is persisted and a resumed request keeps the same feature/run identity. Once a validated implementation handoff exists, target it explicitly with a task, for example:

```text
/do-work --spec account-recovery Implement task T-1 from the approved handoff
```

Execution is a separate authority boundary. `/do-work` acquires one exclusive execution claim for the exact handoff digest, dispatches only the claimed task slice, and records implementation, review, and executed-test evidence. `evaluateImplementationConformance(...)` must pass every requirement/acceptance subject before the claim is released; a blocked result retains the claim for repair. Evidence from another handoff cannot be borrowed.

### CTO preparation and execution

`/cto <task>` runs the resident CTO in the main session; `/cto` alone enters standby for messenger tasks. The CTO is never spawned with `task(agent=cto)`. During multi-feature preparation, independent feature workspaces may run in parallel, while facets for the same feature/phase have one writer. Queue reasons remain visible: `capacity`, `depth`, `ownership`, `active_phase`, `same_feature_serialized`, or `nested_cto`. Nested CTO attempts queue behind the resident run rather than creating another orchestrator.

Each feature and phase receives its own trusted decision (`approve_continue`, `request_changes`, or `approve_stop`); one feature's decision never applies to another. After Tasks approval, CTO preparation emits the review packet and takes a final hard stop: it does not start implementation.

For a separate CTO execution request, preflight freezes a mapping over explicit feature/run selectors and exact handoff digests. A human must confirm the exact `mapping_id` and `mapping_hash` with trusted checkpoint proof before `dispatchCtoSpecificationMapping(...)` can run. Safe slicing gives every task one owner, records dependencies and shared-contract serialization, and runs only independent slices in parallel. Conformance is evaluated independently per feature: a passing feature releases its claim, while a blocked feature retains its claim and its own remediation findings.

### Errors, next actions, and ownership invariants

| Error or condition | Meaning | Next action |
| --- | --- | --- |
| `SPEC_ARGUMENT_INVALID` / `SPEC_SELECTOR_AMBIGUOUS` | Command grammar is invalid or an option was repeated/misplaced. | Use the command's `Usage:` line; provide one leading `--feature` and one request where allowed. |
| `SPEC_SELECTOR_REQUIRED` / `SPEC_PATH_UNAUTHORIZED` | Identity or path is missing, unsafe, or outside the authorized project root. | Provide an explicit safe feature id/run identity or a project-local import path. |
| `SPEC_CONSTITUTION_SOURCE_AMBIGUOUS` / `SPEC_STATE_INVALID` | Policy discovery or durable workspace state cannot be selected safely. | Resolve the competing/invalid source, then rerun the reported command; do not delete or overwrite state to force progress. |
| `SPEC_TEMPLATE_*` / `SPEC_LANGUAGE_UNRESOLVED` | Presentation content or language selection is invalid. | Fix the feature/project configuration or request language, then rerun the phase and review the new validation. |
| `SPEC_MIGRATION_BLOCKED` | Legacy state failed compatibility, identity, or constitution checks. | Follow the diagnostic paths, provide explicit selectors/binding, and rerun migration. |
| `SPEC_HANDOFF_INCOMPLETE` / `SPEC_HANDOFF_STALE` | No current approved handoff exists, or upstream content changed. | Run the returned `/specify`, `/spec-plan`, or `/spec-tasks` next action and obtain fresh approvals. |
| `SPEC_EXECUTION_CLAIMED` | Another active owner holds the exact handoff claim. | Do not take over; wait for release or repair by that owner, then retry. |

The durable state, artifact hashes, checkpoint proofs, claims, and mapping bindings are the source of truth. Workers author only their declared typed artifacts; coordinators do not invent semantic content; approval never grants execution authority; execution never changes ownership or scope without a new explicit claim.

## Public API

The following excerpt assumes `ownerForCwd` is an activation-bearing
`WorkflowOwnerIdentity` whose descriptor requires a physical project-local
marker, and `transaction.token` came from `openWorkflowActivation` plus
`beginRegistryRegistration`. A bundle must pass that same owner/resolver/token
to every registration seam; it must not register ownerless hooks.

```typescript
import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "my-extension",
    roles: { /* role -> agent name */ },
    scopeMap: [/* glob -> scope rules */],
    flags: { /* glob -> flag */ },
    resolveCwd: resolveSessionCwd,
    owner: ownerForCwd,
    registrationToken: transaction.token,
  });
}
```

## Custom bundle — with your own model-role taxonomy
## Bundle-owned workflow profiles

A bundle can register additional profiles with the core interpreter:

```typescript
import profile from "./workflows/feature-regression.json" with { type: "json" };
import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";

registerTeamWorkflow(pi, {
  workflowProfiles: [profile],
  roles: { "regression-executor": "manual-qa" },
  resolveCwd: resolveSessionCwd,
  owner: ownerForCwd,
  registrationToken: transaction.token,
});
```

The shipped `feature-regression` and `spec-preparation` profiles are platform-neutral. A bundle supplies the platform-specific executor, observer, adapter, and oracle roles; the workflow contracts remain reusable across mobile, web, desktop, and service environments.

Registered profiles are included in `loadAllProfiles()` and can be selected explicitly by setting `classification.workflow` to the registered profile name. They do not override the standard Type × Complexity matrix implicitly; this keeps domain-specific profiles from hijacking unrelated feature or bug-fix requests. Bundles should perform semantic intent classification before setting the explicit workflow.

> Полный гайд по созданию своего набора агентов (frontmatter, model-роли,
> registerTeamWorkflow, slash-команды, минимальный скелет бандла):
> **[`docs/adding-agents.md`](../docs/adding-agents.md)**.

`defaultFullstackModelRoles` ships as the default 14-entry taxonomy, but any bundle
can override it with its own `ModelRoleEntry[]` while reusing the helpers
(`resolveRoleChain`, `isResearchRequest`, `isResearchResponse`):

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  type ModelRoleEntry,
} from "@andvl1/omp-workflows-core";


const MY_MODEL_ROLES: ModelRoleEntry[] = [
  { role: "rust-architect", agents: ["architect"], standardFallback: "@slow" },
  { role: "rust-developer", agents: ["developer-rust"], standardFallback: "@task" },
];

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-rust",
    roles: defaultFullstackRoles, // engine-level role mapping (unchanged)
    resolveCwd: resolveSessionCwd,
    owner: ownerForCwd,
    registrationToken: transaction.token,
  });
  // ...use MY_MODEL_ROLES + resolveRoleChain in your `/rust-model-roles validate` command.
}
```

Or use the built-in fullstack defaults (matches the shipped `/omp-model-roles` command):

```typescript
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  defaultFullstackScopeMap,
  defaultFullstackFlags,
} from "@andvl1/omp-workflows-core";

registerTeamWorkflow(pi, {
  roles: defaultFullstackRoles,
  scopeMap: defaultFullstackScopeMap,
  flags: defaultFullstackFlags,
  resolveCwd: resolveSessionCwd,
  owner: ownerForCwd,
  registrationToken: transaction.token,
});
```

## Sub-exports

The sibling `./queue` sub-export is an unsupported fullstack-internal primitive, not an activation or authentication boundary. External/custom adapters must use the curated `./cto-runtime` and `./registry` surfaces instead of importing queue internals. Hostile same-process extensions are outside the threat model; the queue still enforces no-follow and project-root containment for its own file operations.

The engine surface is also available directly:

- `loadAllProfiles()`, `loadProfile(name)`, `selectProfile(profiles, classification)`, `resolveWorkflow(type, complexity, autonomous)`
- `resolveConfig(cwd)`, `resolveScope(files, config)`, `applyConditional(...)`, `shouldSkip(...)`
- `writeState(cwd, state)`, `readState(cwd)`, `setStageStatus(...)`, `setPause(...)`, `checkMonotonic(...)`, `resolveState(cwd)`
- `writeArtifactPinned(pinnedRoot, artifactsDirRelative, id, data)`, `readArtifactPinned(pinnedRoot, artifactsDirRelative, id)`, `persistReturnedArtifactsPinned(pinnedRoot, artifactsDirRelative, artifacts)`
- `appendDoDItemPinned(pinnedRoot, artifactsDirRelative, ...)`, `closeDoDItemPinned(pinnedRoot, artifactsDirRelative, ...)`, `readDoDPinned(pinnedRoot, artifactsDirRelative)`, `isDoDComplete(dod)`, `isRootCauseDocumentedPinned(pinnedRoot, artifactsDirRelative)`

- `defaultFullstackModelRoles`, `resolveRoleChain`, `isResearchRequest`, `isResearchResponse`, `validateResearchRequest`, `validateResearchResponse` (model-role taxonomy + research request/response validators, types `ModelRoleEntry`, `InventoryModel`, `RoleLookup`, `RoleResolution`, `ResearchRequest`, `Response`, `BenchmarkSource`, `ResearchRecommendation`)


## Workflows

`workflows/*.json` ships with the package: 11 profiles (`full-feature`, `standard`, `lightweight`, `debug-cycle`, `bug-fix`, `emergency`, `research`, `review`, `spec-preparation`, `feature-regression`, `cto`) plus the typed artifact schema. Bundles can ship their own profiles by replacing or extending; the engine reads them from the package's `workflows/` directory.

## Build

```bash
npm run build
npm run typecheck
npm test
```

## License

MIT.
