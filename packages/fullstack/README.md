# @andvl1/omp-workflows-fullstack

Default fullstack bundle for `@andvl1/omp-workflows-core`. Ships 17 specialized agents and 31 domain skills for Spring/Kotlin/React/KMP/Telegram-bot projects.

## Install

```bash
npm install @andvl1/omp-workflows-fullstack @andvl1/omp-workflows-core
```

## What it does

`@andvl1/omp-workflows-fullstack` is a thin wrapper that calls `registerTeamWorkflow(pi, opts)` with the fullstack defaults:

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  defaultFullstackScopeMap,
  defaultFullstackFlags,
} from "@andvl1/omp-workflows-core";

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-fullstack",
    roles: defaultFullstackRoles,
    scopeMap: defaultFullstackScopeMap,
    flags: defaultFullstackFlags,
  });
}
```

The agents/ and skills/ directories are picked up by omp's discovery automatically.

## What's inside

- 17 agents (analyst, architect, code-reviewer, developer-{kotlin,go,mobile}, devops, diagnostics, discovery, frontend-developer, init-mobile, manual-qa, qa, security-tester, tech-researcher, coordinator, coordinator-yolo)
- 31 skills (kotlin-spring-boot, kmp, react-vite, telegram-mini-apps, ...)

## Build

```bash
npm run build
```

## License

MIT.
