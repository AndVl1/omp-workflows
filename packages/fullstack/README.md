# @andvl1/omp-workflows-fullstack

Default fullstack bundle for `@andvl1/omp-workflows-core`. Ships 17 specialized agents, 31 domain skills, and 8 OMP custom-TS slash commands for Spring/Kotlin/React/KMP/Telegram-bot projects.

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
| `/omp-model-roles` | Validate per-agent model-role configuration or return a delegated research prompt. |

Each command is a TypeScript module at `commands/<name>/index.ts`. They receive a `HookCommandContext` (ui, cwd, sessionManager, modelRegistry) and return a string prompt or void — they do **not** drive subagent dispatch themselves (the `task` tool is owned by the main agent in OMP 17.x).

## Model roles

Each agent class has a first-choice role followed by a standard fallback in frontmatter (`model: ["@class-role", "@standard-role"]`). Configure the first role when you want a class-specific model; otherwise OMP resolves the standard role.

| Роль | Агенты | Фоллбэк | Пример конфига |
| --- | --- | --- | --- |
| `architect` | `architect` | `@slow` | `architect: anthropic/claude-opus-4-6` |
| `reviewer` | `code-reviewer` | `@slow` | `reviewer: openai/gpt-5.4` |
| `security` | `security-tester` | `@slow` | `security: anthropic/claude-sonnet-4-6` |
| `coordinator` | `coordinator`, `coordinator-yolo` | `@slow` | `coordinator: anthropic/claude-opus-4-6` |
| `researcher` | `tech-researcher`, `discovery` | `@smol` | `researcher: google/gemini-2.5-flash` |
| `analyst` | `analyst` | `@task` | `analyst: openai/gpt-5-mini` |
| `developer-go` | `developer-go` | `@task` | `developer-go: openai/gpt-5.3-codex` |
| `developer-kotlin` | `developer-kotlin` | `@task` | `developer-kotlin: anthropic/claude-sonnet-4-6` |
| `frontend-developer` | `frontend-developer` | `@task` | `frontend-developer: google/gemini-2.5-pro` |
| `developer-mobile` | `developer-mobile`, `init-mobile` | `@task` | `developer-mobile: anthropic/claude-sonnet-4-6` |
| `devops` | `devops` | `@task` | `devops: openai/gpt-5.3-codex` |
| `diagnostics` | `diagnostics` | `@task` | `diagnostics: anthropic/claude-sonnet-4-6` |
| `qa` | `qa` | `@task` | `qa: openai/gpt-5-mini` |
| `manual-qa` | `manual-qa` | `@task` | `manual-qa: anthropic/claude-sonnet-4-6` |

## Конфигурация моделей ролей

Persisted role assignments use `provider/model[:thinking]`, for example `anthropic/claude-sonnet-4-6:high`.

- Project scope: `.omp/config.yml` under `modelRoles:`.
- Global scope: `~/.omp/agent/config.yml` under `modelRoles:`.
- In the interactive TUI, `/model` without arguments opens the native fullscreen Model Hub. Set `modelRoleStorage` to `project` or `global` to choose where role assignments persist.
- `/switch` (Alt+P) opens the TUI session-only model picker and does not rewrite role assignments. On ACP/text command surfaces, `/model <id>` performs a quick session switch.

Example project configuration:

```yaml
modelRoleStorage: project
modelRoles:
  architect: anthropic/claude-opus-4-6:high
  researcher: google/gemini-2.5-flash
```

Role values are matched against the authenticated model inventory. If a role is missing or cannot resolve, its standard fallback remains available.

## /omp-model-roles

`/omp-model-roles validate` (also the default) reads settings read-only, inspects authenticated models, checks all 17 bundled agent frontmatter files, and prints a bounded table. It never calls `setModelRole` or `setProjectModelRole`, writes `.omp/config.yml`, or edits agent files.

`/omp-model-roles recommendations` returns a closed orchestration contract for the main agent: save the bounded immutable inventory, call `task({agent: 'tech-researcher', outputSchema: ..., schemaMode: 'strict', task: ...})`, extract exactly one JSON object, and apply `validateResearchResponse` against the saved inventory before rendering anything. Invalid/malformed responses, web failures, task errors, and cancellation produce a warning with no recommendation table.

После `/omp-model-roles recommendations` агент выполнит research автоматически. Если он начал делать что-то постороннее — попросите его строго следовать инструкции команды.

Example:

```text
/omp-model-roles validate (3 available models)
role | agents | fallback | status | config-value | source
architect | architect | @slow | fallback (anthropic/claude-opus-4-6) | — | default
researcher | tech-researcher,discovery | @smol | class (google/gemini-2.5-flash) | google/gemini-2.5-flash | project
...
In the interactive TUI, use /model without arguments to assign project/global roles and /switch (Alt+P) for session-only selection. On ACP/text command surfaces, /model <id> quickly switches the session model.
```

## What's inside

- 17 agents (`analyst`, `architect`, `code-reviewer`, `developer-{kotlin,go,mobile}`, `devops`, `diagnostics`, `discovery`, `frontend-developer`, `init-mobile`, `manual-qa`, `qa`, `security-tester`, `tech-researcher`, `coordinator`, `coordinator-yolo`)
- 31 skills (`kotlin-spring-boot`, `kmp`, `react-vite`, `telegram-mini-apps`, …)
- 8 custom-TS slash commands (see above)

## FAQ

**Почему не копии агентов?** Model roles keep one agent definition per class and let the native OMP resolver select models. The superseded PR #12 duplicated agents and created maintenance drift.

**Что если задан `task.agentModelOverrides`?** An explicit `agentModelOverrides` entry has priority over both frontmatter and class roles, matching `structured-subagent.ts` semantics. `/omp-model-roles` reports this as an INFO warning.

**Что если роль написана с опечаткой?** An unknown or unresolved class role is skipped and the standard fallback is tried. If neither selector resolves, the status is `none` and the command reports a warning.

**Как открыть UI ролей и как временно сменить модель?** В interactive TUI `/model` без аргументов открывает native Model Hub для project/global role assignments, а `/switch` (Alt+P) выбирает модель только для текущей сессии. На ACP/text command surfaces `/model <id>` выполняет быстрый session switch.

## Build

```bash
npm run build
npm run typecheck    # includes tsconfig.commands.json
npm test
```

## License

MIT.
