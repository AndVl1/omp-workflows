# @omp-workflows/fullstack

Default fullstack bundle for `@omp-workflows/core`. Ships 17 specialized agents and 31 domain skills for Spring/Kotlin/React/KMP/Telegram-bot projects.

## Install

Packages live in **GitHub Packages** under `@omp-workflows`. Configure npm once:

```bash
echo "@omp-workflows:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=ghp_xxx" >> ~/.npmrc

npm install @omp-workflows/fullstack
```

```bash
omp plugin install @omp-workflows/fullstack
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

The `agents/` and `skills/` directories inside this package are picked up by omp's discovery automatically.

## What's inside

- 17 agents (analyst, architect, code-reviewer, developer-{kotlin,go,mobile}, devops, diagnostics, frontend-developer, init-mobile, manual-qa, qa, security-tester, tech-researcher, coordinator, coordinator-yolo, discovery, security-reviewer)
- 31 skills (kotlin-spring-boot, kmp, react-vite, telegram-mini-apps, ...)

## Source of truth

The agent and skill markdown files in this package's tarball originate from `@omp-workflows/content` (../content). At publish time, `scripts/sync-content.mjs` copies them in via `npm run prepack`; `npm run postpack` (or `--restore`) clears them so the working tree stays clean. Do not edit `packages/fullstack/{agents,skills}` directly — they are regenerated.

To change the bundle, edit `packages/content/{agents,skills}`.

## Build

```bash
npm run sync-content   # materialise content/ into agents/ + skills/
npm run build          # tsc
```

## License

MIT.
