---
name: custom-agent-bundle
description: Build or migrate a custom omp-workflows bundle — agents, model roles, workflow gates/tools/commands, activation ownership, authenticated host/session controller and trusted actor resolver. Use when creating a custom agent set or debugging workflow_registration/workflow_admission errors after a bundle upgrade.
---

# Custom Agent Bundle — adding your own agents

Ориентиры: публичные контракты установленного `@andvl1/omp-workflows-core` и
host/session adapters официальных fullstack/internal bundles. Не переноси
предположения о callback context из старой версии OMP без проверки.
Полный гайд: `docs/adding-agents.md` в монорепозитории. Если установлен только
пакет, используй эту инструкцию и публичные `.d.ts`; отсутствие checkout
монорепозитория не должно мешать разбору admission-ошибок.

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

## 4. Регистрация workflow и доверенная host-сессия

Полноценный bundle соединяет три независимые поверхности:

1. `registerTeamWorkflow` — gates, config и observability.
2. `createWorkflowToolAdapter(...).register(pi)` — `workflow_*` tools.
3. `registerWorkflowCommands` — `/do-work`, `/team`, `/cto` либо
   namespaced surface.

Все используют один owner identity и controller одной host-сессии. Не
регистрируй отдельный controller для каждого инструмента. Полная замена
bundle требует отключения прежнего owner, а не зависимости от load order.
`roles` задаёт mapping workflow-ролей на агентов, `scopeMap` — glob/scope/dev
mapping, `flags` — условия профилей. Эти настройки не подтверждают identity.

### Обязательная пара callbacks

В `registerTeamWorkflow` наличие `getSessionController` требует
`resolveTrustedToolCallActor`. TypeScript запрещает неполную комбинацию;
JS-потребитель получает `[workflow_registration:missing_actor_resolver]`
до установки hooks. Это ошибка интеграции бандла, а не повреждение run.
Не исправляй её удалением controller, отключением admission или подстановкой
`actor: "orchestrator"` / `hasUI: true`.

Порядок реализации host adapter:

1. Захвати доверенную interactive host identity на lifecycle-границе.
   При callback проверяй точную session-manager identity, session ID,
   worktree, session-file identity при наличии и согласованность profile.
   Совпадение строкового ID само по себе недостаточно. `hasUI` — не credential.
2. Разрешай cwd из текущего доверенного host/session manager, не из
   `process.cwd()`. Commands, tools и raw hooks должны разделять controller,
   даже если используют разные обёртки для проверки context.
3. Для аутентифицированного host без selected run верни
   `{ kind: "authenticated-interactive-host-no-run" }`.
   Core отдельно проверяет отсутствие execution claim. Не выдавай этот
   результат всем callers и не используй его как fallback после исключения.
4. Для ordinary run проверь selected run, active claim и точный artifacts
   directory, затем верни `{ actor: "orchestrator", artifactsDir }`.
   Для CTO используй отдельный результат
   `{ kind: "authenticated-interactive-host-cto", run_id, ownership_epoch }`
   только из подтверждённого claim. Worker authority не выводится из raw actor.
5. Для известной причины отказа верни
   `{ kind: "denied", code: TrustedToolCallDenialCode }`.
   Не возвращай произвольный текст/exception как диагностику: core формирует
   безопасное сообщение по коду. `undefined` означает отказ без объяснения;
   это допустимо для старого resolver, но затрудняет расследование.

Callback `resolveTrustedToolCallActor(ctx, cwd, runId)` получает host context,
не model/tool input. Не используй параметры инструмента для выдачи полномочий.
Эталонные функции — `resolveFullstackTrustedToolCallActor` в
`packages/fullstack/src/index.ts` и `resolveInternalTrustedToolCallActor` в
`packages/omp-workflows-internal/src/index.ts`; изучай их вместе с lifecycle
capture и controller callbacks, не копируй только разрешающий `return`.

Активацию project-specific bundle проверяй до установки активных hooks.
Если bundle не должен влиять на посторонние проекты, отсутствие project
marker означает отсутствие его активных workflow hooks, а не возврат
`undefined` из уже установленного resolver.

### Диагностика без чтения исходников

Отказы имеют `[workflow_admission:<code>]`, объяснение, `Action` и `Report`.
Сначала прочитай код и действие; не пытайся обойти отказ другой shell-тулой.
Текст может уточняться, автоматизация должна опираться на стабильный код.

| Код | Куда смотреть |
|---|---|
| `invalid_host_context`, `untrusted_actor_context` | Неподдерживаемый context или неподтверждённый actor; исправлять host adapter, не подставлять поля вручную |
| `host_session_not_captured` | Lifecycle capture и загрузка extension до вызова tools |
| `headless_host_session` | Поддерживаемый interactive TUI/RPC host вместо print/task |
| `session_identity_mismatch` | Другая/заменённая сессия, manager или session file |
| `worktree_mismatch`, `host_profile_mismatch` | Согласованность callback с захваченным worktree/profile |
| `session_controller_unavailable`, `controller_context_mismatch` | Общий controller и host callbacks бандла |
| `selected_run_mismatch`, `execution_claim_mismatch` | Правильный run и штатное согласование ownership |
| `artifacts_scope_mismatch` | Каталог артефактов именно выбранного run |
| `controller_resolution_failed`, `session_controller_resolution_failed` | Ошибка authoritative state/controller, не обязательно отсутствующий пакет |
| `cwd_unavailable`, `cwd_resolution_failed` | Отсутствующий host workspace или ошибка cwd callback; не подставлять `process.cwd()` |
| `actor_unresolved` | Resolver вернул `undefined` без объяснения; проверить capture/совместимость и добавить точную denied-причину |
| `actor_resolver_failed`, `actor_resolver_invalid_result` | Исключение или несовместимый результат resolver; автору bundle проверить API OMP/core |
| `run_control_unreadable`, `no_run_claim_present` | Нечитаемый control или уже существующий claim; штатная recovery/сверка, не удаление state |
| `cto_claim_mismatch`, `cto_marker_unauthenticated` | Точный live CTO claim/entrypoint; marker в тексте не выдаёт authority |
| `native_authority_resolution_failed` | Проверка native worker authority в core/host; репорт без подмены identity |
| `workflow_state_recovery_required` | Подтверждённая controller необходимость recovery canonical state; обновление bundle не восстанавливает отсутствующий/повреждённый run |

Не удаляй `.work-state`, не редактируй claims и не объявляй неизвестных workers
завершёнными ради обхода отказа. Ошибки установки/imports исправляй отдельно:
они не объясняют автоматически identity или ownership mismatch.

Для репорта сообщи безопасное admission-сообщение, версии OMP/core/bundle,
способ установки и активации, название инструмента, сценарий
idle/selected/CTO/worker и предшествующее переключение сессии/ветки/worktree.
При регрессии после обновления укажи старые и новые версии. Не прикладывай
tokens, capabilities, ownership proofs, raw context, tool inputs, exception
text или полный transcript.

## 5. Slash-команды

Workflow-команды регистрирует `registerWorkflowCommands`; не подменяй их
одноимёнными custom-TS копиями. Custom-TS остаётся способом добавить
уникальную вспомогательную команду, например проверку model-ролей:

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

В scratch-проекте с установленным bundle проверь не только auxiliary
`validate`, но и настоящую интерактивную TUI/RPC-сессию:

- Без выбранного workflow обычные `bash`, `write`, `edit` допускаются.
- Штатная workflow-команда проходит
  `workflow_prepare → workflow_instructions → workflow_begin`.
- Foreign manager с тем же ID, raw actor spoof, profile/worktree mismatch,
  неправильные selected/CTO claims и нечитаемый control остаются отказами
  с различимыми кодами. Positive native worker path не ломается.
- JS-регистрация controller без resolver явно отвергается до hooks;
  TypeScript тоже запрещает эту комбинацию.
- Вне области активации bundle не блокирует посторонний проект.

Print-mode (`omp -p`) не доказывает interactive host admission. Unit-тесты
адаптера не заменяют проверку установленного bundle на целевой версии OMP.

## 7. Минимальный скелет бандла

```
omp-workflows-rust/
├── package.json          # omp.extensions + files: dist, agents, skills и используемые ресурсы
├── src/
│   ├── index.ts          # activation boundary, три workflow seam, один owner
│   ├── identity.ts       # WorkflowOwnerIdentity
│   ├── host-session.ts   # lifecycle capture, общий controller, trusted resolver
│   └── agent-mapping.ts  # live discovery → effective role mapping
├── agents/              # rust-architect.md, developer-rust.md, rust-qa.md
├── commands/            # только уникальные вспомогательные custom-TS команды
└── tsconfig.json
```

Типы и хелперы — из `@andvl1/omp-workflows-core`, не дублируй.
