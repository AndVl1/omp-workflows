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

У workflow-бандла три независимых слоя. `registerTeamWorkflow` подключает
гейты, observability и seed-if-absent runtime config, но сам по себе **не**
регистрирует ни `workflow_*` tools, ни slash-команды:

```typescript
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  createWorkflowToolAdapter,
  registerTeamWorkflow,
  registerWorkflowCommands,
  type WorkflowOwnerIdentity,
} from "@andvl1/omp-workflows-core";

const BUNDLE_ID = "@acme/omp-workflows-rust";

// Реализация должна брать cwd из session context/sessionManager и никогда не
// подменять отсутствующее значение на process.cwd().
const resolveSessionCwd = (ctx: unknown): string | undefined => {
  if (!ctx || typeof ctx !== "object") return undefined;
  const value = (ctx as { cwd?: unknown }).cwd;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const ownerForCwd = (cwd: string): WorkflowOwnerIdentity => ({
  owner_id: BUNDLE_ID,
  bundle_id: BUNDLE_ID,
  owner_kind: "rust",
  activation_marker: "omp-rust",
  host_range: ">=18 <19",
  provenance: {
    package: BUNDLE_ID,
    entrypoint: "dist/index.js",
    cwd,
    config_path: join(cwd, ".omp", "team.config.json"),
  },
});

export default function (pi: ExtensionAPI) {
  const registration = {
    label: BUNDLE_ID,
    roles: { /* workflow-роль → имя агента */ },
    scopeMap: [ /* glob → scope + dev_agent */ ],
    flags: { /* флаг → glob-список */ },
    designSystem: null,
    resolveCwd: resolveSessionCwd,
    owner: ownerForCwd,
  };

  registerTeamWorkflow(pi, registration);

  createWorkflowToolAdapter({
    resolveCwd: resolveSessionCwd,
    owner: ownerForCwd,
    // Вернуть свежий AgentMappingState; ошибка должна блокировать begin.
    beforeBegin: refreshAndReturnLiveAgentMapping,
  }).register(pi);

  registerWorkflowCommands(pi, {
    resolveCwd: resolveSessionCwd,
    owner: ownerForCwd,
  });
}
```

Все три вызова используют один owner identity. Core разрешает ровно одного
владельца на canonical worktree для `workflow_registration`,
`workflow_tools` и `config_writer`; другой bundle получает `owner_conflict`.
Полная замена поэтому делается отключением старого extension, а не ставкой на
порядок загрузки двух bundles.

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

### Runtime actualization and fallback

`roles` остаётся декларативным **желаемым** mapping, а не гарантией того, что
агент реально загружен. Fullstack на `session_start` вызывает OMP
`discoverAgents(cwd)` и публикует эффективный mapping в
`.work-state/runtime/agent-mapping.json` (файл локальный и не меняет
`.omp/team.config.json`):

1. выбранный в `roles` агент используется, если он есть в live inventory;
2. затем проверяется ordered `fallbackChains` бандла;
3. для разрешённых ролей последним fallback является встроенный OMP `task`;
4. если кандидатов нет, роль помечается `unavailable`, а `workflow_begin`
   блокируется с перечислением кандидатов — неизвестное имя не уходит в
   `task` и не маскируется под успешный dispatch.

Для fullstack `security-tester` намеренно не деградирует до generic worker:
отсутствие security-агента требует его добавить/включить или явно изменить
mapping. Если capability уже создана, но ни один dispatch ещё не
авторизован, resume автоматически перевыпускает её с актуальным roster.
Capability с уже начатым dispatch не переписывается.

Свой bundle может использовать те же pure helpers:

```typescript
const mapping = buildAgentMapping({
  roles,
  availableAgents: discovered.agents.map(agent => agent.name),
  fallbackChains,
  genericFallbackRoles: ["analyst", "qa"],
});
writeAgentMapping(cwd, mapping);
```

Если подходящего агента нет, корректные варианты — ordered semantic fallback,
`task` с явной degraded-диагностикой или fail-closed блокировка для критичной
роли. Подставлять имя отсутствующего агента нельзя: это приводит к
`role-agent roster mismatch` уже после выдачи capability.

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

### Extension-команды — основной workflow surface

`registerWorkflowCommands` регистрирует `/do-work`, `/team` и `/cto` через
`ExtensionAPI.registerCommand`. Handler:

1. один раз определяет session cwd;
2. проверяет owner claim;
3. строит workflow prompt;
4. отправляет его через `pi.sendUserMessage`.

Команда не спавнит субагента напрямую: prompt проходит обычные
`before_agent_start` / `context` hooks, затем resident main agent вызывает
`workflow_*` tools активного owner.

Для безопасного сосуществования bundles используй namespace:

```typescript
registerWorkflowCommands(pi, {
  commandPrefix: "rust",
  resolveCwd: resolveSessionCwd,
  owner: ownerForCwd,
  buildDoWorkPrompt: buildRustDoWorkPrompt, // optional; do-work + team
});
```

Это публикует `/rust-do-work`, `/rust-team`, `/rust-cto`. `namespace` —
legacy-алиас `commandPrefix`. Для полного изменения CTO prompt отдельного
builder option нет: регистрируй собственную extension-команду либо добавляй
инструкции через hooks.

Поздний extension может заменить handler с тем же именем в command map OMP,
но это **не** передаёт ему workflow capabilities. Если его handler использует
другой owner, выполнение блокируется `owner_conflict` до отправки prompt.
Надёжная полная замена — не загружать исходный bundle; частичное
сосуществование — использовать `commandPrefix`.

### Custom-TS команды

Файл `.omp/commands/<name>/index.ts` подходит для уникальных вспомогательных
команд (`/init-team`, `/session-report` и т.п.) и старых runtimes:

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

Зарегистрированная extension-команда имеет приоритет над одноимённой
project-local custom-TS копией. Поэтому правка
`.omp/commands/do-work|team|cto` не является override API.

### Extension-хуки (`before_agent_start`, `context`, ...)

Если нужно дополнить стандартный prompt, не копируя command handler:

```typescript
pi.on("before_agent_start", (event) => {
  // Инжект project policy/context; стандартный workflow prompt уже проходит
  // через normal OMP lifecycle.
});
```

`HookCommandContext` custom-TS команды не имеет `task`-тула. Гарантированную
делегацию выполняет resident main agent после получения prompt.

---

## 6. Проверка

```bash
npm run typecheck && npm run build && npm test
```

- Команда `validate` своего бандла должна проверить: frontmatter каждого
  агента (name/description/tools/model), модель-роли из `modelRoles` юзера,
  отсутствие коллизий с `BUILTIN_ROLES`, live mapping и владельцев всех трёх
  workflow capabilities.
- Slash inventory должен содержать ровно выбранный surface (bare либо
  namespaced); same-name handler другого owner обязан fail-closed дать
  `owner_conflict`.
- Live-smoke: штатная workflow-команда должна пройти
  `workflow_prepare → workflow_instructions → workflow_begin`; отдельная
  `validate`-команда проверяет mapping/owner без изменения canonical state.

---

## 7. Минимальный скелет бандла

```
omp-workflows-rust/
├── package.json          # omp.extensions: ["./dist/index.js"]
├── src/
│   ├── index.ts          # workflow + tool adapter + slash commands, один owner
│   ├── identity.ts       # WorkflowOwnerIdentity для canonical cwd
│   └── agent-mapping.ts  # live discovery → AgentMappingState
├── agents/
│   ├── rust-architect.md
│   ├── rust-developer.md
│   └── rust-qa.md
├── commands/             # только уникальные auxiliary custom-TS команды
│   └── rust-model-roles/
│       ├── index.ts      # validate + рекомендации
│       └── _roles.ts     # RUST_MODEL_ROLES: ModelRoleEntry[]
└── tsconfig.json
```

Типы и хелперы (`ModelRoleEntry`, `resolveRoleChain`, валидаторы
ResearchRequest/Response) — из `@andvl1/omp-workflows-core`, не дублируй.

---

## 8. См. также

- **Собственный канал связи (эскалации CTO)** — `docs/adding-escalation-adapter.md`:
  интерфейс `EscalationAdapter` в core, жизненный цикл outbox → send → answers,
  референсы HTTP/Telegram в fullstack.
