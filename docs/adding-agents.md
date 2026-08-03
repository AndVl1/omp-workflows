# Adding your own agents (custom dev bundle)

Как запилить собственный набор агентов поверх `@andvl1/omp-workflows-core` —
например, для Rust-, Go- или mobile-проекта. Механика проверена на
`@andvl1/omp-workflows-fullstack` (17 агентов, 8 команд) и omp 17.2.x.

> **Агенту потребителя**: эта инструкция доступна как skill `custom-agent-bundle`
> из **обоих** пакетов: `@andvl1/omp-workflows-core` (установка `omp plugin
> install @andvl1/omp-workflows-core` — плагин-манифест `omp: {}` есть,
> скиллы дискаверятся без extension entry) и `@andvl1/omp-workflows-fullstack`
> (полный плагин с хуками/командами/агентами). `docs/` сам по себе omp не
> дискаверит — включай `docs` в `package.json#files` только для человека.

---

## 1. Как omp находит агентов

Агенты — это markdown-файлы с YAML-frontmatter. Приоритет дискавери
(высший побеждает, `task/discovery.ts:62-137`):

1. Проект: `<cwd>/.omp/agents/*.md`
2. Пользователь: `~/.omp/agent/agents/*.md`
3. Extension-пакеты: `<extension-root>/agents/*.md` (в порядке корней
   из `listOmpExtensionRoots`)
4. Bundled-агенты самого omp

Для плагина: положи файлы в `agents/` пакета и укажи директорию в
`package.json#files` (как в fullstack: `files: ['dist', 'agents', ...]`).
При `omp plugin install` пакет попадает в `~/.omp/plugins/node_modules/`,
и omp автоматически находит `<root>/agents/`.

### Переопределение

Агент из `project .omp/agents/` с тем же `name` перекрывает extension-агента.
Это штатный способ точечно подправить поведение без форка.

---

## 2. Frontmatter агента

Поля парсятся в `parseAgentFields` (`discovery/helpers.ts:253-330`):

| Поле | Тип | Обязательно | Что делает |
|---|---|---|---|
| `name` | string | да | Имя агента (имя файла `<name>.md` должно совпадать) |
| `description` | string | да | Описание для диспатча (когда спавнить) |
| `tools` | CSV/массив | нет | Разрешённые тулы; `yield` добавляется автоматически; имена нормализуются (`builtin-names.ts`) |
| `model` | string \| string[] | нет | Паттерн модели: `"@role"` или массив-цепочка фоллбэков |
| `thinkingLevel` | `auto\|low\|medium\|high` | нет | Уровень reasoning |
| `spawns` | `"*"` \| массив | нет | Разрешение спавнить субагентов (`"*"` — любых) |
| `blocking` | boolean | нет | Блокирующий агент |
| `prewalk` | boolean \| string | нет | Ручной prewalk / кастомная цель |
| `autoloadSkills` | CSV/массив | нет | Автозагрузка скиллов |
| `output` | string | нет | Формат вывода |
| `readSummarize` | boolean | нет | Суммаризация при чтении |

### Пример (developer-go из fullstack)

```markdown
---
name: developer-go
model: ["@developer-go", "@task"]
thinkingLevel: auto
description: Go developer - implements CLI tools, system programming, microservices. USE PROACTIVELY for Go implementation.
tools: read, write, edit, glob, grep, bash, web_search
---

# Go Developer

You are the **Go Developer** — implement Go code following the plan.
```

---

## 3. Model-роли (какую модель получает агент)

- Пользователь настраивает `modelRoles` в глобальном `~/.omp/agent/config.yml`
  или project `<cwd>/.omp/config.yml`:
  ```yaml
  modelRoles:
    developer-go: opencode-go/deepseek-v4-flash:high
  ```
- Агент во frontmatter объявляет цепочку: `model: ["@developer-go", "@task"]`.
  Резолв: первый паттерн, который даёт модель (`resolveModelRoleValue`);
  неизвестная `@роль` → фоллбэк на следующий (`resolveConfiguredRolePattern`).
- Таксономия ролей — **build-time, из core**: типы `ModelRoleEntry` и
  хелперы `resolveRoleChain`, `isResearchRequest`, `isResearchResponse`.
  Дефолт для fullstack — `defaultFullstackModelRoles` (14 ролей), твой
  бандл определяет свою:

```typescript
import type { ModelRoleEntry } from "@andvl1/omp-workflows-core";

const RUST_MODEL_ROLES: ModelRoleEntry[] = [
  { role: "rust-architect", agents: ["architect"], standardFallback: "@slow" },
  { role: "rust-developer", agents: ["developer-rust"], standardFallback: "@task" },
  { role: "rust-qa", agents: ["qa"], standardFallback: "@task" },
  // ...
];
```

`BUILTIN_ROLES` (default, smol, slow, vision, plan, designer, commit, tiny,
task, advisor) — знание OMP-харнесса; core OMP-agnostic. Если нужна
проверка коллизий с built-in'ами — объяви локальный список (как fullstack
делает в своей команде).

---

## 4. Регистрация workflow

`registerTeamWorkflow(pi, opts)` из core подключает движок стадий, гейты
и observability. Опции (`RegisterOptions`, `core/src/index.ts:28-41`):

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-rust",
    roles: { /* workflow-роль → имя агента */ },
    scopeMap: [ /* glob → scope + dev_agent */ ],
    flags: { /* флаг → glob-список */ },
    designSystem: null,
  });
}
```

### roles — маппинг workflow-ролей на агентов

Ключи — роли из профилей (`standard.json`, `full-feature.json` и т.д.),
значения — имена твоих агентов:

```typescript
roles: {
  analyst: "rust-analyst",
  "tech-researcher": "rust-researcher",
  architect: "rust-architect",
  "developer-rust": "rust-developer",
  qa: "rust-qa",
  "manual-qa": "rust-manual-qa",
  "code-reviewer": "rust-reviewer",
  diagnostics: "rust-diagnostics",
}
```

### scopeMap — какой агент пишет код под какие файлы

```typescript
scopeMap: [
  { glob: ["**/*.rs", "**/Cargo.toml"], scope: "rust", dev_agent: "rust-developer" },
  { glob: ["**/*.ts", "**/frontend/**"], scope: "frontend", dev_agent: "rust-web" },
],
```

### flags — условные стадии (`skip_if` в профилях)

```typescript
flags: {
  has_security: ["**/auth/**", "**/security/**"],
  has_infra: ["**/Dockerfile", "**/.github/workflows/**"],
}
```

Стадии с `skip_if: "!scope.has_security"` пропускаются, если glob не
матчится (`scope.ts:72-111`).

---

## 5. Slash-команды

Два пути:

### Custom-TS команды (как fullstack `/omp-model-roles`)

Файл `.omp/commands/<name>/index.ts` (или в `commands/` пакета + bootstrap):

```typescript
import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

const factory = (_api: CustomCommandAPI): CustomCommand => ({
  name: "my-cmd",
  description: "Do something.",
  async execute(_args: string[], ctx: HookCommandContext): Promise<string> {
    return "result";
  },
});
export default factory;
```

Omp находит их из `<cwd>/.omp/commands/<name>/index.ts` на старте сессии.
Extension-пакет копирует свои команды через `copy-commands` (см. fullstack
`src/copy-commands.ts` + `postinstall`).

### Extension-хуки (`before_agent_start`, `input`, ...)

В `src/index.ts` бандла:

```typescript
pi.on("before_agent_start", (event) => {
  // детект маркера, инжект developer-инструкции — см. fullstack
  // src/before-agent-start-marker.ts (strict recommendations, vp9)
});
```

`HookCommandContext` (custom-TS) НЕ имеет `task`-тула — команды не могут
спавнить субагентов сами. Для гарантированной делегации из команды —
паттерн маркер + `before_agent_start` hook (developer-attributed сообщение),
как в `/omp-model-roles recommendations`.

---

## 6. Проверка

```bash
npm run typecheck && npm run build && npm test
```

- Команда `validate` своего бандла должна проверить: frontmatter каждого
  агента (name/description/tools/model), модель-роли из `modelRoles` юзера,
  отсутствие коллизий с `BUILTIN_ROLES`, инвентарь моделей.
- Live-smoke: `omp -p "/my-cmd validate"` в scratch-проекте с
  `node_modules/@andvl1/omp-workflows-<bundle>` (npm link на монорепо).

---

## 7. Минимальный скелет бандла

```
omp-workflows-rust/
├── package.json          # files: ["dist", "agents", "commands", "README.md"]
├── src/
│   └── index.ts          # registerTeamWorkflow(pi, { label, roles, scopeMap, flags })
├── agents/
│   ├── rust-architect.md
│   ├── rust-developer.md
│   └── rust-qa.md
├── commands/
│   └── rust-model-roles/
│       ├── index.ts      # CustomCommand (validate + рекомендации)
│       └── _roles.ts     # RUST_MODEL_ROLES: ModelRoleEntry[]
└── tsconfig.json
```

Типы и хелперы (`ModelRoleEntry`, `resolveRoleChain`, валидаторы
ResearchRequest/Response) — из `@andvl1/omp-workflows-core`, не дублируй.
