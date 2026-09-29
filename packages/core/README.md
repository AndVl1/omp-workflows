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

Этот короткий пример регистрирует только gates/config. Он не создаёт
session-aware workflow-бандл и не регистрирует workflow tools или команды.
Полная интеграция использует общий session controller и доверенный host
adapter на всех трёх поверхностях:
[`контракт и пример`](../../docs/adding-agents.md#4-регистрация-workflow).

### Trusted host admission и миграция бандла

В `registerTeamWorkflow` передача `getSessionController` требует
`resolveTrustedToolCallActor`: TypeScript запрещает неполную комбинацию, а
JS-потребитель получает `[workflow_registration:missing_actor_resolver]`
до установки hooks. Если после обновления обычный `bash`/`write`/`edit`
блокируется в свежей сессии, проверь именно host adapter бандла; отсутствие
workflow не отменяет проверку личности. Не удаляй controller для обхода
ошибки и не используй `actor`/`hasUI` как credentials.

`TrustedToolCallResolution` поддерживает
`{ kind: "denied", code: TrustedToolCallDenialCode }` для объяснимого отказа.
Положительный no-run результат допустим только для аутентифицированного
host; core отдельно проверяет отсутствие selected run и execution claim.
Ordinary run, CTO и native worker сохраняют свои проверки полномочий.

Отказы содержат стабильный `[workflow_admission:<code>]`, объяснение,
безопасное действие и состав репорта. Известный отказ адаптера, отсутствие
результата, исключение и ошибка canonical state не должны интерпретироваться
как одна и та же проблема. В репорт включай сообщение, версии OMP/core/bundle,
имя инструмента и сценарий idle/selected/CTO/worker, но не секреты, raw context
или полный transcript. Подробности и действия:
[`диагностика интеграции`](../../docs/adding-agents.md#как-разбирать-отказ-admission).

## Жизненный цикл обычного workflow

Обычные запуски имеют явный режим `new`, `resume` или `rework`. Наличие старых файлов состояния само по себе не превращает новую задачу в продолжение. Для `/team` действует тот же контракт: это alias `/do-work`.

```text
/do-work --new Добавить экспорт отчётов
/do-work продолжи экспорт отчётов
/do-work --resume
/do-work --resume --run <run-id>
/do-work --rework Исправить результат экспорта
/do-work --list
/do-work --list --all-branches
```

UUID не обязателен для обычного пользовательского сценария: имя задачи, однозначный фрагмент или пункт показанного списка разрешаются в точный `run_id` до мутации. `--run <run-id>` остаётся техническим selector для автоматизации и диагностики. `--` завершает разбор options, поэтому флаги внутри текста задачи не интерпретируются. Неоднозначный выбор возвращает список с названием, веткой, статусом и этапом; ошибочный явный selector не получает fallback.

### CTO lifecycle and exact-run continuation

`/cto` is a registered host ingress, not a prompt-only command. Use
`/cto --run <exact-cto-id> <task>` only when continuing a known CTO run; the
selector identifies the run but does not prove ownership. Ingress acquires the
authenticated host claim and publishes the CTO state atomically before the
prompt is sent. It never scans for a latest active run.

The claim is bound to the worktree, branch, host session, process and ownership
epoch. A managed session release may retain pending worker slots, so a later
`/cto --run` continuation must reacquire the same run and inspect its canonical
answers plus escalation state before dispatching. Only a dispatcher-created
`.omp/inbox/answer-retry-*.json` marker together with a persisted
`delivery_status: "pre-send-rejected"` answer whose `delivery_run_id`,
`delivery_ownership_epoch` and `delivery_session_id` match the current claim
may be retried once. Canonical status alone is not replay authority.
`accepted`, `in-flight`, `unknown`, legacy or mismatched answers are
advisory/recovery evidence; never blindly replay them. Transport-only
`.omp/inbox/answer-*` markers do not grant replay authority.

Corrupt or markdown-only legacy CTO state fails closed with recovery guidance.
An explicit selector still requires an exact branch and authenticated owner;
the marker in a task prompt alone is never authority. Native child reservations
settle from the persisted CTO tool-call/slot identity, independently of
ordinary workflow dispatch origins, and terminal claim settlement happens only
on an actual terminal CTO state transition.

Resident CTO dispatch is a separate native route from ordinary workflow
selectors: the main session reads/commits the exact `CtoState` through
`cto_state`, dispatches the configured team lead with the exact CTO
`run=<id> slice=<id>` marker, and the lead dispatches only its configured
workers with inherited authority. CTO/lead tasks must not call ordinary
`workflow_prepare`/`workflow_status`/`workflow_instructions`/`workflow_begin`
or completion/advance tools with the CTO slug. The resolved slice profile
still supplies its stage, gate, checkpoint, typed-artifact, validation, and DoD
obligations; they are checked through native evidence and CTO state commits.
Per-team DoD remains a supplemental file at the exact configured relative
`teams[].dod_path` (default `.work-state/artifacts/<team>/dod.json`), never
canonical CTO state.

For a claimless legacy **JSON** run whose coordinator session is no longer
available, use `/cto --recover-legacy --run <exact-cto-id>` (or the internal
bundle's `/omp-cto` equivalent). This is an explicit recovery operation, not
ordinary resume. It requires an interactive host confirmation that the previous
coordinator **and all its workers have stopped**; missing legacy ownership
records alone are not evidence of quiescence. Decline or headless invocation
does not recover the run or send a CTO prompt.

Recovery rechecks the authenticated session, branch and exact state/control
bytes after confirmation. It refuses existing execution claims, managed release
provenance for this run, pending work/leases, terminal runs, and malformed or
unrecognized typed state. Supported legacy-only metadata is quarantined in a
byte-exact backup; missing `updated_at` and completion-intent rationale are
filled with new recovery metadata, never historical approval. Active waves,
team progress and canonical plan/history remain intact. A single lifecycle
transaction publishes the repaired state, a fresh engine-owned claim, and
immutable `legacy-recovery/<source-sha256>/raw-state.json` plus `receipt.json`
under the same CTO run directory. Subsequent managed handoffs use ordinary
`--run` continuation. Do not delete old markers or hand-edit claims to bypass
these checks; markdown-only or invalid JSON is not repaired by this command.

Release provenance is a state witness, not a writable acknowledgement: after
handoff, an unexplained canonical CTO state change makes reacquisition
`recovery_required`; core does not rehash arbitrary suspended-state writes.
The supported host lifecycle is a type-only `session_shutdown` emitted on
actual session disposal. Session replacement is handled by the authenticated
`session_switch` transition; core does not infer an old owner from a
non-existent shutdown `session_id` field.

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
