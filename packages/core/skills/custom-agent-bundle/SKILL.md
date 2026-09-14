---
name: custom-agent-bundle
description: Add your own agents on top of omp-workflows-core — build a custom dev bundle (Rust/Go/mobile), agent frontmatter, model-role taxonomy, registerTeamWorkflow roles/scopeMap/flags, custom slash commands, before_agent_start hooks. Use when the user asks to create custom agents, add a new agent set, build a custom bundle/workflow plugin, write a /rust-model-roles-style command, or wire new bundles into /do-work.
---

# Custom Agent Bundle — adding your own agents

Проверено на `@andvl1/omp-workflows-fullstack` (17 агентов, 8 команд) и omp 17.2.x.
Полный, runnable пример с marker-bound owner и регистрационной транзакцией:
[`docs/adding-agents.md`](../../../../docs/adding-agents.md#4-регистрация-workflow).

> Этот скилл доставлен как часть `@andvl1/omp-workflows-core` —
> установлен через `omp plugin install @andvl1/omp-workflows-core`.

## 1. Как omp находит агентов

Агенты — markdown с YAML-frontmatter. Приоритет дискавери (высший побеждает):

1. Проект: `<cwd>/.omp/agents/*.md`
2. Пользователь: `~/.omp/agent/agents/*.md`
3. Extension-пакеты: `<extension-root>/agents/*.md`
4. Bundled-агенты omp

Для плагина: файлы в `agents/` пакета + `files` в `package.json` (`dist`, `agents`, `skills`, ...).
Проектный агент с тем же `name` переопределяет extension-агента.

## 2. Frontmatter агента

| Поле | Тип | Обязательно | Что делает |
|---|---|---|---|
| `name` | string | да | Имя агента; файл `<name>.md` должен совпадать |
| `description` | string | да | Когда спавнить |
| `tools` | CSV/массив | нет | Разрешённые тулы; `yield` добавляется автоматически |
| `model` | string or string[] | нет | `"@role"` или цепочка фоллбэков |
| `thinkingLevel` | `auto\|low\|medium\|high` | нет | Уровень reasoning |
| `spawns` | `"*"` or массив | нет | Разрешение спавнить субагентов |
| `blocking` / `prewalk` / `autoloadSkills` / `output` / `readSummarize` | — | нет | Прочие настройки |

```markdown
---
name: developer-rust
model: ["@rust-developer", "@task"]
thinkingLevel: auto
description: Rust developer - implements CLI tools and system code.
tools: read, write, edit, glob, grep, bash
---
# Rust Developer
Implement Rust code following the approved plan.
```

## 3. Model-роли

Пользователь настраивает `modelRoles` в `~/.omp/agent/config.yml` или `<cwd>/.omp/config.yml`:

```yaml
modelRoles:
  rust-developer: opencode-go/deepseek-v4-flash:high
```

Агент объявляет ordered fallback chain: `model: ["@rust-developer", "@task"]`.
Таксономия ролей — **build-time, из core**: `ModelRoleEntry[]` и helpers
`resolveRoleChain`, `isResearchRequest`, `isResearchResponse`. Свой bundle определяет свою:

```typescript
import type { ModelRoleEntry } from "@andvl1/omp-workflows-core";

const RUST_MODEL_ROLES: ModelRoleEntry[] = [
  { role: "rust-architect", agents: ["architect"], standardFallback: "@slow" },
  { role: "rust-developer", agents: ["developer-rust"], standardFallback: "@task" },
];
```

## 4. Регистрация workflow

Регистрация всегда marker-bound и project-local. Bundle bootstrap явно создаёт
свой физический marker (например `.omp/rust.activation.json`) с точными байтами;
обычная установка пакета, extension load и `session_start` не создают marker и
не устанавливают ничего глобально. `WorkflowOwnerIdentity.activation.required`
содержит этот path (и digest точных байт, если bundle его публикует).

Один и тот же activation-bound `owner`/`resolveCwd` передаётся в
`registerTeamWorkflow`, `createWorkflowToolAdapter` и
`registerWorkflowCommands`. Перед profile/gate/config writes bundle открывает
`openWorkflowActivation`, начинает `beginRegistryRegistration` для
`["workflow_profiles", "constitution_gate", "runtime_config", "workflow_tools"]`, передаёт
opaque `transaction.token`, затем делает commit/rollback. Cleanup выполняется
через `closeWorkflowActivation`; не вызывайте raw owner claim/release/close API.

Полный код с marker descriptor, resolver, transaction lifecycle и explicit owner:
[`docs/adding-agents.md`](../../../../docs/adding-agents.md#4-регистрация-workflow).

Обязательные свойства:

- `resolveCwd` читает canonical session manager context и возвращает `undefined`,
  если root не известен; никогда не подставляет `process.cwd()`.
- `owner(cwd)` возвращает `WorkflowOwnerIdentity` с `activation` descriptor,
  project-local marker и `provenance.cwd/config_path` в том же root.
- Все три registration seams получают тот же owner; registration/token scope
  нельзя подменять owner id, marker string или самодельным token.
- Transaction failure закрывается и не оставляет claims; marker mismatch и
  owner conflict блокируют mount.

## 5. Slash-команды

`registerWorkflowCommands` регистрирует команды через extension API. Используйте
namespace для coexistence:

```typescript
registerWorkflowCommands(pi, {
  commandPrefix: "rust",
  resolveCwd: resolveSessionCwd,
  owner: ownerForCwd,
});
```

Это публикует `/rust-do-work`, `/rust-team`, `/rust-cto`; command handler не
спавнит субагента напрямую. Подготовка prompt проходит обычный OMP lifecycle,
после чего resident main agent вызывает активные `workflow_*` tools.

Custom-TS команды подходят для уникальных вспомогательных команд (`/init-team`),
но не являются override API для extension-команд.

## 6. Проверка

Проверяйте marker bootstrap, owner activation, exact capability scope, commit /
rollback, resolver без cwd fallback, live role mapping и единственную выбранную
command surface. Используйте focused source/import smoke; project-wide build и
full suite запускает release/QA owner.

## 7. Минимальный скелет бандла

```
omp-workflows-rust/
├── package.json          # omp.extensions + files: dist, agents, skills
├── src/
│   ├── index.ts          # marker activation + one registry transaction
│   └── activation-marker.ts # exact project-local marker bytes/digest
├── agents/
├── commands/rust-model-roles/
└── workflows/
```

Типы и helpers — из `@andvl1/omp-workflows-core`, не дублируйте registry authority.
