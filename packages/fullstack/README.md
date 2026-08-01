# @andvl1/omp-workflows-fullstack

Default fullstack bundle for `@andvl1/omp-workflows-core`. Ships 17 specialized agents, 31 domain skills, and 7 OMP custom-TS slash commands for Spring/Kotlin/React/KMP/Telegram-bot projects.

## Install

```bash
npm install @andvl1/omp-workflows-fullstack @andvl1/omp-workflows-core
```

Then bootstrap the slash commands into your project:

```bash
npm run --prefix node_modules/@andvl1/omp-workflows-fullstack copy-commands
# or
npx omp-workflows-copy-commands
```

OMP discovers the commands from `.omp/commands/<name>/index.ts` on the next session start.

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

The extension registers gates (`before_agent_start`, `session_stop`, `tool_call`) and writes `.omp/team.config.json`. **It does NOT register slash commands** — those ship as OMP custom-TS commands in `commands/` (see below).

The `agents/` and `skills/` directories are picked up by OMP's discovery automatically.

## Slash commands (v0.4.0+)

| Command | Purpose |
| --- | --- |
| `/team <task>` | Classify and resolve the workflow; return a prompt the main agent runs through its `task` tool. |
| `/pulse` | Read-only project digest: workflow state, git status, last commits, beads ready. |
| `/team-next` | Pop the next entry from `.work-state/queue.json` and route to `/team`. |
| `/team-yolo` | Same as `/team-next` but wrapped in `[AUTONOMOUS]`. |
| `/init-team` | Write `.omp/team.config.json` with the fullstack defaults (idempotent). |
| `/interview <topic>` | Delegate to the `analyst` agent for structured clarifying questions. |
| `/coordinator-stats` | Return `.work-state/coordinator/profile-stats.md` if it exists. |

Each command is a TypeScript module at `commands/<name>/index.ts`. They receive a `HookCommandContext` (ui, cwd, sessionManager, modelRegistry) and return a string prompt or void — they do **not** drive subagent dispatch themselves (the `task` tool is owned by the main agent in OMP 17.x).

## What's inside

- 17 agents (`analyst`, `architect`, `code-reviewer`, `developer-{kotlin,go,mobile}`, `devops`, `diagnostics`, `discovery`, `frontend-developer`, `init-mobile`, `manual-qa`, `qa`, `security-tester`, `tech-researcher`, `coordinator`, `coordinator-yolo`)
- 31 skills (`kotlin-spring-boot`, `kmp`, `react-vite`, `telegram-mini-apps`, …)
- 7 custom-TS slash commands (see above)

## Build

```bash
npm run build
npm run typecheck    # includes tsconfig.commands.json
npm test
```

## License

MIT.
