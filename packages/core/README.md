# @omp-workflows/core

Profile-driven multi-stage workflow engine for omp. No agents, no skills — pure runtime.

## Install

Published to **GitHub Packages**. Configure npm once:

```bash
echo "@omp-workflows:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=ghp_xxx" >> ~/.npmrc

npm install @omp-workflows/core
```

## Public API

```typescript
import { registerTeamWorkflow } from "@omp-workflows/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "my-extension",
    roles: { /* role -> agent name */ },
    models: { /* agent -> model spec */ },
    scopeMap: [/* glob -> scope rules */],
    flags: { /* glob -> flag */ },
    commands: ["team", "pulse", "init-team"], // subset
  });
}
```

Or use the built-in defaults for fullstack projects:

```typescript
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  defaultFullstackModels,
  defaultFullstackScopeMap,
  defaultFullstackFlags,
} from "@omp-workflows/core";

registerTeamWorkflow(pi, {
  roles: defaultFullstackRoles,
  models: defaultFullstackModels,
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
