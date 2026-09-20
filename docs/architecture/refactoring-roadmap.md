# Roadmap

## Status

План поэтапного рефакторинга движка, подготовленный 2026-09-19. Это planning-документ, не описание уже реализованной архитектуры и не разрешение на реализацию всех блоков. Первый change: [run-lifecycle](../../openspec/changes/run-lifecycle/proposal.md). Следующие changes создаются отдельно после проверки предыдущих результатов.

Фактический статус `run-lifecycle`: основной runtime cutover реализован и подтверждён targeted/process доказательствами; final 7.4 integration/CI также принят (run `35541403305` на repair head `3d853bc1582aebe4a3950cd85673a848767432c7`, install/build/typecheck/test PASS). Live-приёмка пользовательских journeys ещё не закрыта; delivered не означает acceptance 7.3.

В рамках реализованного cutover подтверждены:

- canonical UUID identity для run; revision IDs сохраняют timestamp-UUID composite format и не объявляются отдельными UUID, при этом identity run/revision независима от ветки, host-сессии и текста задачи;
- явный command intent и различение `new`/`resume`/`rework`, включая выбор по названию или стабильному показанному списку без обязательного ввода UUID;
- транзакционные migration/recovery/rework с сохранением evidence, откатом staged transaction до commit и forward repair после commit; backup сохраняется как evidence, а не используется как механизм rollback; fail-closed `migration_required`, идемпотентное восстановление и отсутствие удаления marker или ручного редактирования canonical state;
- единый canonical authority для state, ownership claims, capability/epoch scopes и late-result routing; busy/recovery UX сохраняет конфликт и поддерживаемый путь сверки;
- cutover потребителей report/session/observability к выбранным canonical run/revision; viewer использует тот же selector либо явно сообщает migration-required/недоступность, без legacy authority fallback;
- process-level fault/race proof и готовность terminal E2E harness/PTY prerequisite. Это подтверждает готовность harness, но не результат живого OMP journey;
- final 7.4 workspace integration/CI: run `35541403305` на repair head `3d853bc1582aebe4a3950cd85673a848767432c7` завершился успешно для install, build, typecheck и test; эта проверка не заменяет live 7.3.

Открытой runtime-приёмкой остаётся live 7.3 (зарегистрированные `/do-work` journeys, fresh-session resume и missing-input recovery) до отдельного отчёта QA/Main; закрытие run-lifecycle требует этого live proof и синхронизации примеров команд с фактическими transcript/evidence и canonical-state checks для A → B → C → A. 8.1/8.2 остаются pending до фиксации документации и этой audit-проверки.

Будущими и не реализованными остаются политика автономии и scheduler, programmatic continuation main agent и redesign viewer/graph model. Archive lifecycle в этом change не вводится и является non-goal, а не обещанным будущим блоком. UUID остаётся внутренней идентичностью; ручной state repair не является поддерживаемым способом эксплуатации.

## Outcomes

1. Последовательные задачи и запуски `/do-work` в одном worktree, на одной или разных ветках, не требуют удаления маркеров или перемещения `.work-state` вручную.
2. Автономный запуск не требует участия пользователя для обычных промежуточных решений: пользователь может уйти до завершения работы.
3. Результат по умолчанию — протестированная функциональность и готовый PR. Явные требования пользователя имеют приоритет; готовность PR не даёт разрешения на merge или production-деплой.
4. Поведение описано нормативными требованиями и проверяется сквозными сценариями. Добавление функции должно затрагивать понятные ответственности, а не несколько конкурирующих трактовок состояния.

## Evidence

### Baseline before `run-lifecycle`

Исходные наблюдения, собранные при подготовке roadmap до реализации change:

- `packages/core/src/commands/do-work.ts`: наличие состояния текущей ветки автоматически объявлялось продолжением прежней задачи.
- `packages/core/src/engine/run.ts`: новый запуск отвергался при существующем состоянии ветки; свежий `run_key` равнялся имени ветки. Продолжение совмещалось с `reopenFromFeedback`.
- `packages/core/src/engine/state.ts`: выбор состояния зависел от `.active-feature`, legacy root и branch-derived feature path; существовали специальные пути восстановления устаревших указателей.
- `packages/core/workflows/standard.json` и `packages/core/src/engine/types.ts`: текстовые инструкции автономии говорили продолжать, но типизированные правила чекпоинтов требовали человека; legacy-текст не являлся разрешением.
- `packages/core/src/commands/register.ts`, `commands/do-work.ts`, `engine/run.ts`, `engine/stage.ts`: prompt-driven путь и прямой интерпретатор имели разные внешние циклы исполнения, но использовали общие durable-переходы.
- `packages/core/src/index.ts`: общий публичный вход содержал host-интеграцию, регистрацию инструментов и широкий экспорт API.

Аудит `~/Desktop/omp-review.pdf` от 2026-09-06 — исторический источник гипотез: стабилизация ядра, compiler/validator, frozen bundle и граница side effects. Его цифры, результаты тестов и конкретные security findings не считаются автоматически актуальными. Эти наблюдения описывают baseline до change; текущие delivered/pending границы указаны в `Status` и блоке A.

## Principles

- Сначала согласовать наблюдаемое поведение, затем границы кода. Не начинать с массового разнесения файлов по пакетам.
- Сохранить общие durable-переходы, проверки идентичности, scope, артефактов и human proofs. Удобный старт не достигается отключением safety-проверок.
- Для каждого change отдельно перечислять: сохраняемое поведение, намеренные исправления, не затронутые области.
- Завершать перенос ответственности переводом всех потребителей и удалением заменённого пути. Миграционный reader допустим только с описанным назначением; два активных writer/resolver недопустимы.
- Не фиксировать текущие дефекты как совместимость. Существующие тесты, проверяющие только формулировку промпта или прежнюю внутреннюю раскладку, не определяют требуемый контракт.
- Каждый блок включает документацию, совместимость и доказательство поведения; инфраструктура тестирования не заменяет реальный сценарий OMP.

## Target Responsibilities

```text
Request + constraints + defaults
                |
                v
         Run intake / identity
                |
                v
         Execution contract <---- Policy / authorization
                |
                v
          Runtime transitions
             |          |
             v          v
        Persistence   OMP adapter --> Workers / human input
             |
             v
        Status / reports
```

Это логические ответственности, не предписанное число npm-пакетов. Направление зависимостей: адаптеры и представления используют публичные контракты ядра; ядро не должно зависеть от OMP UI, отчётов или конкретных предметных профилей. Точный package cutover обосновывается потребителями в соответствующем change.

## Delivery Blocks

### A. Run lifecycle

**Статус:** основная реализация доставлена и 7.4 integration/CI принята; остаётся acceptance-граница live 7.3.

**Фактический результат:** независимая canonical UUID identity run; revision IDs сохраняют timestamp-UUID composite format; явные `new`, `resume` и `rework`; человекочитаемый выбор из списка или по названию без обязательного UUID; transactional migration/recovery/rework с сохранением evidence, откатом staged transaction до commit и forward repair после commit; backup остаётся evidence, а не механизмом rollback; canonical authority, ownership claims и capability scopes; перевод report/session/observability consumers на выбранный run/revision; готовые process/E2E harness seams.

**Включено:** ingress `/do-work` и `/team`, state resolution, session/run binding, существующие workflow tools/hooks и читатели состояния, защита от одновременно конфликтующего исполнения, миграция legacy state.

**Не включено:** изменение checkpoint permission, автономный scheduler, новая модель retries/budgets, миграция внутреннего CTO portfolio state на новый формат, programmatic continuation main agent и redesign viewer/graph model. Viewer не получает отдельный legacy fallback: он либо читает тот же canonical selector, либо возвращает явную недоступность/migration guidance.

**Следующая проверка:** сценарий «задача A завершена → новая B на той же ветке → новая C на другой ветке → возвращение к A для доработки», fresh-session resume и missing-input recovery должны быть приняты QA/Main через live OMP harness. До этого не объявлять 7.3 PASS; 7.4 уже принят отдельным integration/CI run.

### B. Autonomy and outcome contract

**Зависимость:** стабильная идентичность и границы запусков из A.

**Результат:** цель завершения, режим участия человека и полномочия независимы. В автономном запуске обычные решения делегированы, проверки качества обязательны. Явный запрос важнее defaults.

**Предмет отдельной спецификации:** какие решения могут приниматься автоматически; какие полномочия проверяются до старта; как завершать попытку при недоступных полномочиях/ресурсах без бесконечного ожидания человека; что доказывает готовность функциональности и PR.

**Выход:** на одном обычном профиле устранены противоречия prose/typed policy; после старта нет обязательных человеческих решений в рамках заранее разрешённой задачи. Это ещё не доказательство надёжного продолжения исполнения.

### C. Reliable execution progress

**Зависимость:** A и контракт разрешений/завершения B.

**Результат:** допустимое продолжение не зависит только от того, вспомнит ли main agent длинный orchestration prompt. Pending, terminal result, fan-in, review-fix cycle и восстановление имеют единое поведение на поддерживаемых execution surfaces.

**Перед дизайном этого блока:** проверить реальные host-возможности запуска/возобновления main session и доставки task results; определить, какие части scheduling остаются в OMP adapter. Не обещать фоновый scheduler без доступного host-контракта.

**Выход:** unattended-сценарий до согласованного результата либо честного терминального блокера; инъекции прерывания и повторной доставки не запускают дубликаты и не теряют результаты. При необходимости разделить C на отдельные changes ожидания/сверки результатов и продолжения после прерывания.

### D. Remaining structural boundaries

**Зависимость:** реальные границы, проявившиеся в A–C, а не заранее выбранная пакетная диаграмма.

**Результат:** сократить смешение host registration, state machine, policy, persistence и projections; закрыть ненужные внутренние экспорты и убрать дублирование, оставшееся после функциональных срезов.

**Кандидаты, не обязательства:** compiler/validator до запуска; полный frozen execution bundle; optional domain packs; дальнейшее выделение report/visualize. Каждый кандидат получает отдельное обоснование и change. Trusted executor для произвольных side effects, distributed backend и telemetry overhaul не входят автоматически.

**Выход:** проверенный ацикличный граф зависимостей, объявленные публичные контракты, перенесённые потребители и удалённые старые пути. Модульные границы вводятся и в A–C, если нужны их контракту; D не откладывает модульность на конец.

## Cleanup audit

Аудит tracked migration/scaffold/smoke-кандидатов завершён в рамках 8.2. Disposable temporary material для удаления не найдено:

- `packages/core/src/engine/run-migration.ts` — production explicit importer и recovery path; сохраняется;
- `packages/core/test/smoke.test.ts` — постоянный regression/smoke test package boundary и canonical lifecycle guard; сохраняется;
- `vibe-report/` (включая исторический migration report и lifecycle UX evidence) и `.work-state/cto/run-lifecycle-01a0bacd/artifacts/` — evidence, а не disposable scaffold; сохраняются;
- generated `packages/core/dist/engine/run-migration.*` не является tracked source и не удаляется в этом docs-only изменении.

Карта ответственности намеренно не менялась: package ownership не перемещался.

## Ownership and Integration

В каждом implementation change назначается один владелец интеграции и один writer на затронутую область. Для A интеграционный владелец отвечает за core contracts, persistence и общие файлы; владельцы fullstack, internal и e2e переводят свои потребители после фиксации контракта. Конкретные исполнители назначаются при apply; concurrent запись общих файлов запрещена. Экспортируемые контракты, workspace manifest и lockfile меняет только интеграционный владелец.

## Verification and Completion

Каждый блок завершается:

1. Проверкой нормативных сценариев и отрицательных границ, а не только сборкой.
2. Реальным OMP journey для затронутого пользовательского пути; ограничения окружения явно фиксируются, unit-проверка не выдаётся за live-проверку.
3. Согласованием затронутых документации, API и миграции данных.
4. Удалением заменённой runtime-ветви; сохранённые архивы остаются данными, не альтернативным источником authority.
5. Обновлением roadmap по фактическому результату перед подготовкой следующего change.

Не требуется общий coverage threshold или тест на каждое перемещение файла. Постоянный regression test оправдан конкретным дефектом, границей идентичности, гонкой или восстановлением.

## Open Decisions for Later Changes

Не блокируют A: точные категории автоматических решений B; способ программного продолжения main agent C; набор содержимого полного frozen bundle и границы пакетов D. Эти решения не считаются принятыми самим существованием roadmap.
