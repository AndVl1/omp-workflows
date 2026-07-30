# @omp-workflows/fullstack

Default fullstack bundle for `@omp-workflows/core`. Ships 15 specialized agents and 32 domain skills for Spring/Kotlin/React/KMP/Telegram-bot projects.

## Install

```bash
npm install @omp-workflows/fullstack @omp-workflows/core
```

## What it does

`@omp-workflows/fullstack` is a thin wrapper that calls `registerTeamWorkflow(pi, opts)` with the fullstack defaults:

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  defaultFullstackModels,
  defaultFullstackScopeMap,
  defaultFullstackFlags,
} from "@omp-workflows/core";

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-fullstack",
    roles: defaultFullstackRoles,
    models: defaultFullstackModels,
    scopeMap: defaultFullstackScopeMap,
    flags: defaultFullstackFlags,
  });
}
```

The agents/ and skills/ directories are picked up by omp's discovery automatically.

## What's inside

- 15 agents (analyst, architect, code-reviewer, developer-{kotlin,go,mobile}, devops, diagnostics, frontend-developer, init-mobile, manual-qa, qa, security-tester, tech-researcher, coordinator, coordinator-yolo)
- 32 skills (kotlin-spring-boot, kmp, react-vite, telegram-mini-apps, ...)

## Build

```bash
npm run build
```

## License

MIT.
