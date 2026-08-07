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

(The package carries an `omp: {}` manifest — skills are discovered without
an extension entry; see [`docs/adding-agents.md`](../docs/adding-agents.md).)

## Public API

```typescript
import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "my-extension",
    roles: { /* role -> agent name */ },
    scopeMap: [/* glob -> scope rules */],
    flags: { /* glob -> flag */ },
  });
}
```

## Custom bundle — with your own model-role taxonomy
## Bundle-owned workflow profiles

A bundle can register additional profiles with the core interpreter:

```typescript
import profile from "./workflows/android-feature-regression.json" with { type: "json" };
import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";

registerTeamWorkflow(pi, {
  workflowProfiles: [profile],
  roles: { "feature-regression": "manual-qa" },
});
```

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
});
```

## Sub-exports

The engine surface is also available directly:

- `loadAllProfiles()`, `loadProfile(name)`, `selectProfile(profiles, classification)`, `resolveWorkflow(type, complexity, autonomous)`
- `resolveConfig(cwd)`, `resolveScope(files, config)`, `applyConditional(...)`, `shouldSkip(...)`
- `writeState(cwd, state)`, `readState(cwd)`, `setStageStatus(...)`, `setPause(...)`, `checkMonotonic(...)`, `resolveState(cwd)`
- `writeArtifact(dir, id, data)`, `readArtifact(dir, id)`
- `appendDoDItem(dir, ...)`, `closeDoDItem(dir, ...)`, `readDoD(dir)`, `isDoDComplete(dod)`, `isRootCauseDocumented(dir)`
- `defaultFullstackModelRoles`, `resolveRoleChain`, `isResearchRequest`, `isResearchResponse`, `validateResearchRequest`, `validateResearchResponse` (model-role taxonomy + research request/response validators, types `ModelRoleEntry`, `InventoryModel`, `RoleLookup`, `RoleResolution`, `ResearchRequest`, `Response`, `BenchmarkSource`, `ResearchRecommendation`)


## Workflows

`workflows/*.json` ships with the package: 8 profiles (`full-feature`, `standard`, `lightweight`, `debug-cycle`, `bug-fix`, `emergency`, `research`, `review`) plus the typed artifact schema. Bundles can ship their own profiles by replacing or extending; the engine reads them from the package's `workflows/` directory.

## Build

```bash
npm run build
npm run typecheck
npm test
```

## License

MIT.
