# @andvl1/omp-workflows-core

Profile-driven multi-stage workflow engine for omp. No agents — bundles ship those.
Ships the `custom-agent-bundle` skill (how to add your own agents).

## Install

```bash
npm install @andvl1/omp-workflows-core
```

To expose the bundled skill to the agent (so it can help build a custom
bundle), install core as an omp plugin too:

```bash
omp plugin install @andvl1/omp-workflows-core
```

(The package carries an `omp: {}` manifest — skills are discovered without
an extension entry; see [`docs/adding-agents.md`](../../docs/adding-agents.md).)

## Public API

```typescript
import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "my-extension",
    roles: { /* role -> agent name */ },
    scopeMap: [/* glob -> scope rules */],
    flags: { /* glob -> flag */ },
  });
}
```
## Жизненный цикл обычного workflow

Обычные запуски имеют явный режим `new`, `resume` или `rework`. Наличие старых файлов состояния само по себе не превращает новую задачу в продолжение. Для `/team` действует тот же контракт: это alias `/do-work`.

```text
/do-work --new Добавить экспорт отчётов
/do-work продолжи экспорт отчётов
/do-work --resume
/do-work --resume --run <run-id>
/do-work --rework --run <run-id> Исправить результат экспорта
/do-work --list
/do-work --list --all-branches
```

UUID не обязателен для обычного пользовательского сценария: имя задачи, однозначный фрагмент или пункт показанного списка разрешаются в точный `run_id` до мутации. `--run <run-id>` остаётся техническим selector для автоматизации и диагностики. `--` завершает разбор options, поэтому флаги внутри текста задачи не интерпретируются. Неоднозначный выбор возвращает список с названием, веткой, статусом и этапом; ошибочный явный selector не получает fallback.

### Канонический запуск и восстановление

Для ordinary workflow используется schema 2: `run_id`, `run_key` и `WorkIdentity.run_id` обязаны совпадать. Канонический state находится в `.work-state/runs/<run-id>/state.json`, а неизменяемые результаты доработки или миграции — в `.work-state/runs/<run-id>/revisions/<revision-id>/`. Ветка — контекст маршрутизации и проверки совместимости, а не ключ identity или каталог: новая задача на другой ветке создаёт независимый run; `resume`/`rework` на чужой ветке отклоняются как `run_context_mismatch`.

`resume` в новой host-сессии не восстанавливает старый чат. После `workflow_prepare` агент обязан прочитать `workflow_instructions`, canonical state и обязательные входные artifacts текущего этапа: задачу, classification, cursor, ограничения, решения и provenance завершённых этапов. Отсутствующий или недействительный обязательный input блокирует зависимое действие с `recovery_required`; summary или случайный файл его не заменяют. Сохранённый pending dispatch не запускается повторно: при недоступном host-транспорте сохраняются `background_wait` и `transport_reconnect`.

`rework` сохраняет предыдущий результат в revision snapshot и открывает только затронутую стадию с downstream-зависимостями. Старые artifacts и proofs остаются историей и не завершают новую версию. Терминальный run сохраняется доступным для чтения; отдельного archive lifecycle или обязательной archive-команды нет.

### Конфликты, миграция и транзакционное восстановление

В одном физическом worktree допускается один конфликтующий execution claim. Живой или неизвестно завершённый coordinator/worker даёт `run_busy`; ошибка и receipt `workflow_prepare` сохраняют state неизменным и указывают поддерживаемое следующее действие. `workflow_status` можно использовать для проверки текущего run/stage/capability state. Смерть coordinator не доказывает остановку workers: разрешается resume того же run или reconcile, но не независимый `new` и не force-unlock.

Lifecycle journal и lock/CAS восстанавливаются до следующей мутации. При прерывании **до** canonical commit откатывается только staging, исходные данные остаются нетронутыми; **после** commit выполняется только forward repair с сохранением canonical mapping. Backup — evidence для recovery, а не способ вернуть старую authority.

Legacy root/feature state и прежняя форма `continuation` — только import boundary. Старый API должен быть заменён на явный `resume`/`rework`; неизвестная schema, повреждённая ссылка, активный или неизвестный legacy dispatch дают `migration_required`, `recovery_required` или `run_busy` без создания обходного пустого run. `.work-state/.active-feature` не является runtime authority после cutover. Не удаляйте marker, не перемещайте state вручную и не редактируйте canonical JSON: следуйте diagnostic `next_action` и повторите штатную операцию после устранения причины.

### Status, report и viewer

Status, report и visualization используют тот же canonical selector. В fullstack доступны:

```text
/session-report do-work id=<run-id> [revision=<revision-id>]
/workflow-view do-work id=<run-id> [revision=<revision-id>]
/workflow-view --all
```

У выбранного ordinary run можно открыть конкретную revision; `--all` не совмещается с `revision=`. Legacy state не читается как fallback: report/viewer возвращают явное `migration_required` или `canonical-unavailable` с инструкцией сначала выбрать/import canonical run. Текущий viewer доступен для canonical run/revision и не выбирает latest, slug или `.active-feature`; существенная переработка UI/graph model остаётся отдельным будущим scope.

Подробный stage и artifact contract описан в [`workflows/README.md`](workflows/README.md).


## Custom bundle — with your own model-role taxonomy
## Bundle-owned workflow profiles

A bundle can register additional profiles with the core interpreter:

```typescript
import profile from "./workflows/feature-regression.json" with { type: "json" };
import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";

registerTeamWorkflow(pi, {
  workflowProfiles: [profile],
  roles: { "regression-executor": "manual-qa" },
});
```

The shipped `feature-regression` and `spec-preparation` profiles are platform-neutral. A bundle supplies the platform-specific executor, observer, adapter, and oracle roles; the workflow contracts remain reusable across mobile, web, desktop, and service environments.

Registered profiles are included in `loadAllProfiles()` and can be selected explicitly by setting `classification.workflow` to the registered profile name. They do not override the standard Type × Complexity matrix implicitly; this keeps domain-specific profiles from hijacking unrelated feature or bug-fix requests. Bundles should perform semantic intent classification before setting the explicit workflow.

> Полный гайд по созданию своего набора агентов (frontmatter, model-роли,
> registerTeamWorkflow, slash-команды, минимальный скелет бандла):
> **[`docs/adding-agents.md`](../../docs/adding-agents.md)**.

`defaultFullstackModelRoles` ships as the default 14-entry taxonomy, but any bundle
can override it with its own `ModelRoleEntry[]` while reusing the helpers
(`resolveRoleChain`, `isResearchRequest`, `isResearchResponse`):

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  type ModelRoleEntry,
} from "@andvl1/omp-workflows-core";


const MY_MODEL_ROLES: ModelRoleEntry[] = [
  { role: "rust-architect", agents: ["architect"], standardFallback: "@slow" },
  { role: "rust-developer", agents: ["developer-rust"], standardFallback: "@task" },
];

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-rust",
    roles: defaultFullstackRoles, // engine-level role mapping (unchanged)
  });
  // ...use MY_MODEL_ROLES + resolveRoleChain in your `/rust-model-roles validate` command.
}
```

Or use the built-in fullstack defaults (matches the shipped `/omp-model-roles` command):

```typescript
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  defaultFullstackScopeMap,
  defaultFullstackFlags,
} from "@andvl1/omp-workflows-core";

registerTeamWorkflow(pi, {
  roles: defaultFullstackRoles,
  scopeMap: defaultFullstackScopeMap,
  flags: defaultFullstackFlags,
});
```

## Sub-exports

The engine surface is also available directly:

- `loadAllProfiles()`, `loadProfile(name)`, `selectProfile(profiles, classification)`, `resolveWorkflow(type, complexity, autonomous)`
- `resolveConfig(cwd)`, `resolveScope(files, config)`, `applyConditional(...)`, `shouldSkip(...)`
- `updateStateAtomically(cwd, mutation)`, `setStageStatus(...)`, `setPause(...)`, `checkMonotonic(...)`, `resolveState(cwd)`
- `writeArtifact(dir, id, data)`, `readArtifact(dir, id)`
- `appendDoDItem(dir, ...)`, `closeDoDItem(dir, ...)`, `readDoD(dir)`, `isDoDComplete(dod)`, `isRootCauseDocumented(dir)`
- `defaultFullstackModelRoles`, `resolveRoleChain`, `isResearchRequest`, `isResearchResponse`, `validateResearchRequest`, `validateResearchResponse` (model-role taxonomy + research request/response validators, types `ModelRoleEntry`, `InventoryModel`, `RoleLookup`, `RoleResolution`, `ResearchRequest`, `Response`, `BenchmarkSource`, `ResearchRecommendation`)


## Workflows

`workflows/*.json` ships with the package: 11 profiles (`full-feature`, `standard`, `lightweight`, `debug-cycle`, `bug-fix`, `emergency`, `research`, `review`, `spec-preparation`, `feature-regression`, `cto`) plus the typed artifact schema. Bundles can ship their own profiles by replacing or extending; the engine reads them from the package's `workflows/` directory.

## Build

```bash
npm run build
npm run typecheck
npm test
```

## License

MIT.
