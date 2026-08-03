---
name: custom-agent-bundle
description: Add your own agents on top of omp-workflows-core — build a custom dev bundle (Rust/Go/mobile), agent frontmatter, model-role taxonomy, registerTeamWorkflow roles/scopeMap/flags, custom slash commands, before_agent_start hooks. Use when the user asks to create custom agents, add a new agent set, build a custom bundle/workflow plugin, write a /rust-model-roles-style command, or wire new agents into /do-work.
---

# Custom Agent Bundle — adding your own agents

Проверено на `@andvl1/omp-workflows-fullstack` (17 агентов, 8 команд) и omp 17.2.x.
Полный гайд (с примерами кода): `docs/adding-agents.md` в монорепо плагина.

> Этот скилл доставлен как часть `@andvl1/omp-workflows-core` —
> установлен через `omp plugin install @andvl1/omp-workflows-core`
> (или как зависимость fullstack-плагина).

## 1. Как omp находит агентов

Агенты — markdown с YAML-frontmatter. Приоритет дискавери (высший побеждает, `task/discovery.ts`):

1. Проект: `<cwd>/.omp/agents/*.md`
2. Пользователь: `~/.omp/agent/agents/*.md`
3. Extension-пакеты: `<extension-root>/agents/*.md`
4. Bundled-агенты omp

Для плагина: файлы в `agents/` пакета + `files` в `package.json` (`['dist', 'agents', 'skills', ...]`).
Переопределение: агент из `project .omp/agents/` с тем же `name` перекрывает extension-агента.

## 2. Frontmatter агента (parseAgentFields)

| Поле | Тип | Обязательно | Что делает |
|---|---|---|---|
| `name` | string | да | Имя агента (файл `<name>.md`) |
| `description` | string | да | Когда спавнить |
| `tools` | CSV/массив | нет | Разрешённые тулы; `yield` авто; имена нормализуются |
| `model` | string \| string[] | нет | `"@role"` или цепочка фоллбэков |
| `thinkingLevel` | `auto\|low\|medium\|high` | нет | Reasoning |
| `spawns` | `"*"` \| массив | нет | Разрешение спавнить субагентов |
| `blocking` / `prewalk` / `autoloadSkills` / `output` / `readSummarize` | — | нет | Прочие |

Пример:

```markdown
---
name: developer-rust
model: ["@rust-developer", "@task"]
thinkingLevel: auto
description: Rust developer - implements CLI tools, system programming. USE PROACTIVELY for Rust implementation.
tools: read, write, edit, glob, grep, bash
---
# Rust Developer
...
```

## 3. Model-роли

- Пользователь настраивает `modelRoles` (`~/.omp/agent/config.yml` или `<cwd>/.omp/config.yml`):
  ```yaml
  modelRoles:
    rust-developer: opencode-go/deepseek-v4-flash:high
  ```
- Агент: `model: ["@rust-developer", "@task"]` — первый резолвящийся паттерн побеждает; неизвестная `@роль` → фоллбэк.
- Таксономия — **build-time, из core**: `ModelRoleEntry[]` + `resolveRoleChain`, `isResearchRequest`, `isResearchResponse` из `@andvl1/omp-workflows-core`. Свой бандл определяет свою:
  ```typescript
  import type { ModelRoleEntry } from "@andvl1/omp-workflows-core";
  const RUST_MODEL_ROLES: ModelRoleEntry[] = [
    { role: "rust-architect", agents: ["architect"], standardFallback: "@slow" },
    { role: "rust-developer", agents: ["developer-rust"], standardFallback: "@task" },
  ];
  ```
- `BUILTIN_ROLES` (default/smol/slow/vision/plan/designer/commit/tiny/task/advisor) — знание OMP-харнесса, core OMP-agnostic. Проверку коллизий объявляй локально.

## 4. registerTeamWorkflow

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-rust",
    roles: { architect: "rust-architect", "tech-researcher": "rust-researcher", qa: "rust-qa" },
    scopeMap: [{ glob: ["**/*.rs", "**/Cargo.toml"], scope: "rust", dev_agent: "rust-developer" }],
    flags: { has_security: ["**/auth/**"], has_infra: ["**/Dockerfile"] },
  });
}
```

- `roles` — workflow-роль → имя агента (ключи из `standard.json`/`full-feature.json`).
- `scopeMap` — glob → scope + dev_agent (кто пишет код под файлы).
- `flags` — для `skip_if: "!scope.has_security"` в профилях.

## 5. Slash-команды

Custom-TS (`.omp/commands/<name>/index.ts`):

```typescript
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

const factory = (_api: CustomCommandAPI): CustomCommand => ({
  name: "rust-model-roles",
  description: "Validate per-agent model roles.",
  async execute(_args: string[], ctx: HookCommandContext): Promise<string> {
    return "result";
  },
});
export default factory;
```

ВАЖНО: `HookCommandContext` НЕ имеет `task`-тула — custom-TS команда не может спавнить субагентов сама. Для гарантированной делегации — паттерн маркер + `before_agent_start` hook (developer-attributed сообщение), как в `/omp-model-roles recommendations` (см. fullstack `src/before-agent-start-marker.ts`).

## 6. Проверка

```bash
npm run typecheck && npm run build && npm test
```

Live-smoke: `omp -p "/rust-model-roles validate"` в scratch-проекте с `node_modules/@andvl1/omp-workflows-<bundle>` (npm link на монорепо).

## 7. Минимальный скелет бандла

```
omp-workflows-rust/
├── package.json          # files: ["dist", "agents", "commands", "README.md"]
├── src/index.ts          # registerTeamWorkflow(pi, { label, roles, scopeMap, flags })
├── agents/               # rust-architect.md, rust-developer.md, rust-qa.md
├── commands/rust-model-roles/  # index.ts + _roles.ts (RUST_MODEL_ROLES)
└── tsconfig.json
```

Типы и хелперы — из `@andvl1/omp-workflows-core`, не дублируй.
