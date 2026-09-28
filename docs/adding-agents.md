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

Пример ниже показывает соединение трёх слоёв, а не готовый host adapter.
Extension передаёт в `registerBundle` собственный адаптер, который захватывает
доверенную host identity и возвращает один общий session controller.
Обязательный контракт адаптера описан сразу после примера.

```typescript
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  createWorkflowToolAdapter,
  registerTeamWorkflow,
  registerWorkflowCommands,
  type WorkflowOwnerIdentity,
  type RegisterOptions,
} from "@andvl1/omp-workflows-core";

const BUNDLE_ID = "@acme/omp-workflows-rust";

type HostAdapter = {
  resolveCwd: NonNullable<RegisterOptions["resolveCwd"]>;
  getSessionController: NonNullable<RegisterOptions["getSessionController"]>;
  resolveTrustedToolCallActor: NonNullable<RegisterOptions["resolveTrustedToolCallActor"]>;
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

export function registerBundle(pi: ExtensionAPI, host: HostAdapter) {
  const registration = {
    label: BUNDLE_ID,
    roles: { /* workflow-роль → имя агента */ },
    scopeMap: [ /* glob → scope + dev_agent */ ],
    flags: { /* флаг → glob-список */ },
    designSystem: null,
    resolveCwd: host.resolveCwd,
    getSessionController: host.getSessionController,
    resolveTrustedToolCallActor: host.resolveTrustedToolCallActor,
    owner: ownerForCwd,
  };

  registerTeamWorkflow(pi, registration);

  createWorkflowToolAdapter({
    resolveCwd: host.resolveCwd,
    getSessionController: host.getSessionController,
    owner: ownerForCwd,
    // Вернуть свежий AgentMappingState; ошибка должна блокировать begin.
    beforeBegin: refreshAndReturnLiveAgentMapping,
  }).register(pi);

  registerWorkflowCommands(pi, {
    resolveCwd: host.resolveCwd,
    getSessionController: host.getSessionController,
    owner: ownerForCwd,
  });
}
```

Все три вызова используют один owner identity. Core разрешает ровно одного
владельца на canonical worktree для `workflow_registration`,
`workflow_tools` и `config_writer`; другой bundle получает `owner_conflict`.
Полная замена поэтому делается отключением старого extension, а не ставкой на
порядок загрузки двух bundles.

### Host/session authority — обязательный контракт

Если `registerTeamWorkflow` получает `getSessionController`, он MUST получить и
`resolveTrustedToolCallActor`. Типы запрещают неполную комбинацию; JS-бандл
получает `[workflow_registration:missing_actor_resolver]` до установки hooks и
регистрации владельца. Это ошибка интеграции бандла, не признак повреждённого
workflow. Исправление — реализовать authenticated resolver, а не удалить
controller, ослабить gates или добавить `actor: "orchestrator"` в контекст.
Регистрация без обоих callbacks остаётся низкоуровневым legacy-вариантом,
но не заменяет session-aware интеграцию полноценного workflow-бандла.

Адаптер MUST:

1. Захватывать identity интерактивного host на доверенной lifecycle-границе.
   Проверять точную идентичность session manager, session ID, worktree и
   согласованность явно переданных profile/session полей при каждом вызове.
   `hasUI`, `actor`, tool input и совпадение одного session ID не являются
   самостоятельным доказательством полномочий.
2. Брать cwd из текущего доверенного host/session manager, без fallback к
   `process.cwd()`. Hooks, tools и commands используют controller одной сессии;
   callback-обёртки разных поверхностей могут различаться проверками.
3. Для подтверждённого host без selected run возвращать
   `{ kind: "authenticated-interactive-host-no-run" }`. Core дополнительно
   требует отсутствия execution claim. Нельзя возвращать это значение
   без проверки личности или при ошибке чтения состояния.
4. Для ordinary run возвращать `{ actor: "orchestrator", artifactsDir }`
   только при совпадении selected run, execution claim и каталога артефактов.
   Для CTO использовать отдельный результат
   `{ kind: "authenticated-interactive-host-cto", run_id, ownership_epoch }`
   из текущего точного claim; эти идентификаторы не брать из текста задачи.
5. При известном отказе возвращать
   `{ kind: "denied", code: TrustedToolCallDenialCode }`. Неизвестный отказ
   стороннего адаптера может вернуть `undefined`, но тогда core сообщит, что
   адаптер не объяснил причину. Исключение не становится разрешением.
   Core формирует текст по коду, а не доверяет произвольному тексту адаптера.

Референсы реализации: `resolveFullstackTrustedToolCallActor` в
[`packages/fullstack/src/index.ts`](../packages/fullstack/src/index.ts) и
`resolveInternalTrustedToolCallActor` в
[`packages/omp-workflows-internal/src/index.ts`](../packages/omp-workflows-internal/src/index.ts).
Проверяй их вместе с lifecycle capture и controller callbacks, а не копируй
только финальный `return`.

Активация — отдельная ответственность bundle. Если он предназначен только
для определённых проектов, вне них не устанавливай активные workflow hooks.
Возврат `undefined` из `resolveCwd` или actor resolver после регистрации
означает отсутствие authority, а не отключение расширения.

### Как разбирать отказ admission

Сообщение содержит стабильный `[workflow_admission:<code>]`, объяснение,
`Action` и `Report`. Автоматизация опирается на код, а не на точную английскую
формулировку. Отказ означает, что инструмент не получил разрешения на этом
пути; запуск той же операции через другой shell/tool не исправляет authority.

| Причина | Что исправлять |
|---|---|
| `invalid_host_context`, `untrusted_actor_context` | Неподдерживаемый/неаутентифицированный host context либо явный неподтверждённый actor; проверить адаптер, не подставлять поля вручную |
| `host_session_not_captured`, `headless_host_session` | Lifecycle capture и поддерживаемый интерактивный TUI/RPC entrypoint; print/task-сессия не становится host по `hasUI` |
| `session_identity_mismatch`, `host_profile_mismatch`, `worktree_mismatch` | Соответствие текущего callback захваченной сессии, profile и worktree; не подменять identity |
| `session_controller_unavailable`, `controller_context_mismatch` | Общий controller и корректные host callbacks в bundle |
| `selected_run_mismatch`, `execution_claim_mismatch` | Выбор нужного run и штатное согласование ownership; не удалять `.work-state` и не отменять неизвестных workers |
| `artifacts_scope_mismatch` | Каталог артефактов именно выбранного run, без расширения write scope |
| `controller_resolution_failed`, `session_controller_resolution_failed` | Ошибка получения controller/authoritative state; это не доказательство отсутствующего пакета |
| `cwd_unavailable`, `cwd_resolution_failed` | Host не предоставил workspace либо callback бандла выбросил исключение; не подставлять `process.cwd()` |
| `actor_unresolved` | Resolver не вернул ни authority, ни объяснение; автору bundle нужно проверить capture и вернуть точную причину |
| `actor_resolver_failed`, `actor_resolver_invalid_result` | Исключение в resolver либо несовместимый результат; проверить совместимость API OMP/core/bundle |
| `run_control_unreadable`, `no_run_claim_present` | Нечитаемый canonical control либо существующий execution claim; использовать штатную сверку/recovery, не удалять state |
| `cto_claim_mismatch`, `cto_marker_unauthenticated` | CTO proof не соответствует live claim либо marker не подтверждён; текст marker не является полномочием |
| `native_authority_resolution_failed` | Ошибка проверки native worker authority; репорт core/host-интеграции, не подмена worker identity |
| `workflow_state_recovery_required` | Controller подтвердил необходимость recovery canonical state; обновление bundle само по себе не восстановит отсутствующий/повреждённый run |

Для репорта достаточно полного безопасного admission-сообщения, версий OMP,
core и bundle, способа установки/активации, названия инструмента и сценария:
новая idle-сессия, selected workflow, CTO или worker; было ли переключение
сессии/ветки/worktree. Если ошибки появились сразу после обновления, укажи
версии до и после. Не прикладывай tokens, capabilities, ownership proofs,
сырой context, аргументы инструментов или полный transcript.


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
- Отдельно проверь свежую интерактивную сессию без workflow: обычные `bash`,
  `write` и `edit` должны работать в scratch-проекте. Проверь foreign manager
  с тем же ID, поддельный actor, несовпадение profile/worktree, selected/CTO
  claim и испорченный control: отказы сохраняются, причины различимы.
- Для JS-потребителя передай controller без resolver: регистрация должна
  завершиться явной ошибкой до установки hooks. В TypeScript такая
  комбинация должна отвергаться проверкой типов.

---

## 7. Минимальный скелет бандла

```
omp-workflows-rust/
├── package.json          # omp.extensions: ["./dist/index.js"]
├── src/
│   ├── index.ts          # три workflow seam под одним owner + граница активации
│   ├── identity.ts       # WorkflowOwnerIdentity для canonical cwd
│   ├── host-session.ts   # lifecycle capture, общий controller, trusted actor resolver
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
