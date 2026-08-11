# @andvl1/omp-workflows-fullstack

Default fullstack bundle for `@andvl1/omp-workflows-core`. Ships 16 specialized agents, 27 domain skills, and 7 OMP custom-TS slash command adapters for Spring/Kotlin/React/KMP/Telegram-bot projects.

## Install

```bash
npm install @andvl1/omp-workflows-fullstack @andvl1/omp-workflows-core
```

The extension registers `/do-work`, `/team`, and `/cto` directly during plugin loading, so they appear in slash autocomplete and execute from the installed package without a project-local copy. The copy command remains available for disk-discovery runtimes and explicit bootstrap:

```bash
npm run --prefix node_modules/@andvl1/omp-workflows-fullstack copy-commands
# or
npx omp-workflows-copy-commands
```

On `omp plugin install`, `session_start` performs a SHA-256-aware compatibility sync into `.omp/commands/`. It updates files that still match the previous shipped hash and preserves user edits. The manifest is `.omp/commands/.omp-shipped.json` (schema 2).

## What it does

`@andvl1/omp-workflows-fullstack` is a thin wrapper that calls `registerTeamWorkflow(pi, opts)` with the fullstack defaults:

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  defaultFullstackFlags,
  defaultFullstackModelRoles,
  defaultFullstackRoles,
  defaultFullstackScopeMap,
  registerTeamWorkflow,
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

The taxonomy that backs the bundled `/omp-model-roles validate` command (`defaultFullstackModelRoles`,
14 entries) is imported from `@andvl1/omp-workflows-core` so any other bundle can compose the same
helpers (`resolveRoleChain`, `isResearchRequest`, `isResearchResponse`) against its own `ModelRoleEntry[]`.
The extension registers the workflow gates, writes `.omp/team.config.json`, and registers `/do-work`, `/team`, and `/cto` as authoritative extension commands. Their prompts still pass through OMP's normal user-message lifecycle, so external `before_agent_start`/`context` hooks continue to run. The `commands/` adapters remain the compatibility path for runtimes that only discover custom-TS files from disk; same-name project files are not an override API.

The `agents/` and `skills/` directories are picked up by OMP's discovery automatically.

## Slash commands

| Command | Purpose |
| --- | --- |
| `/cto <task>` | Main-session CTO orchestration into parallel teams. |
| `/do-work <task>` | Classification-first profile-driven workflow. |
| `/team <task>` | Compatibility alias for `/do-work`. |
| `/init-team` | Write `.omp/team.config.json` with detected/default stack mappings. |
| `/interview <topic>` | Delegate structured clarification to the analyst. |
| `/omp-model-roles` | Validate model-role configuration or delegate recommendations. |
| `/session-report [do-work|cto] [id=<id>] [--full]` | Generate a self-contained offline HTML snapshot of one workflow session. |

The three workflow entry points are registered directly; `/init-team`, `/interview`, `/omp-model-roles`, and `/session-report` remain custom-TS modules copied into project-local `.omp/commands/`. Most commands return prompts and do not dispatch subagents directly. `/session-report` is deterministic: it reads persisted state/artifacts, renders HTML, and writes only under `.work-state`.

## Model roles

Each agent class has a first-choice role followed by a standard fallback in frontmatter (`model: ["@class-role", "@standard-role"]`). Configure the first role when you want a class-specific model; otherwise OMP resolves the standard role.

| Роль | Агенты | Фоллбэк | Пример конфига |
| --- | --- | --- | --- |
| `architect` | `architect` | `@slow` | `architect: anthropic/claude-opus-4-6` |
| `reviewer` | `code-reviewer` | `@slow` | `reviewer: openai/gpt-5.4` |
| `security` | `security-tester` | `@slow` | `security: anthropic/claude-sonnet-4-6` |
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

- 15 agents (`analyst`, `architect`, `code-reviewer`, `cto`, `developer-{kotlin,go,mobile}`, `devops`, `diagnostics`, `discovery`, `frontend-developer`, `init-mobile`, `manual-qa`, `qa`, `security-tester`, `team-lead`, `tech-researcher`)
- 27 domain skills
- 7 custom-TS slash commands (see above)

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
