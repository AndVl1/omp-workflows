# Roadmap

## Status

План поэтапного рефакторинга движка, подготовленный 2026-09-19. Это planning-документ, не описание уже реализованной архитектуры и не разрешение на реализацию всех блоков. Первый change: [run-lifecycle](../../openspec/changes/run-lifecycle/proposal.md). Следующие changes создаются отдельно после проверки предыдущих результатов.

Фактический статус `run-lifecycle`: основной runtime cutover, final 7.4 integration/CI и зарегистрированные live journeys подтверждены targeted/process/live evidence. A → B → C → A rework, fresh-session resume без старого chat, содержательное решение из artifact, terminal ordinary work, missing-input `recovery_required`, pending/no-duplicate и natural host exit закрыты receipts; cleanup временного fixture/wrapper материала завершён владельцами. Примеры команд синхронизированы с observed journeys; 7.3 live acceptance и документационные 8.1/8.2 готовы к закрытию.
По delivery evidence: **7.3 live acceptance — PASS; 8.1 documentation —
PASS; 8.2 cleanup/ownership audit — PASS**. Эти отметки относятся к receipts и
owner cleanup manifest этого acceptance wave; они не расширяют scope change.

В рамках реализованного cutover подтверждены:

- canonical UUID identity для run; revision IDs сохраняют timestamp-UUID composite format и не объявляются отдельными UUID, при этом identity run/revision независима от ветки, host-сессии и текста задачи;
- явный command intent и различение `new`/`resume`/`rework`, включая выбор по названию или стабильному показанному списку без обязательного ввода UUID;
- транзакционные migration/recovery/rework с сохранением evidence, откатом staged transaction до commit и forward repair после commit; backup сохраняется как evidence, а не используется как механизм rollback; fail-closed `migration_required`, идемпотентное восстановление и отсутствие удаления marker или ручного редактирования canonical state;
- единый canonical authority для state, ownership claims, capability/epoch scopes и late-result routing; busy/recovery UX сохраняет конфликт и поддерживаемый путь сверки;
- cutover потребителей report/session/observability к выбранным canonical run/revision; viewer использует тот же selector либо явно сообщает migration-required/недоступность, без legacy authority fallback;
- process-level fault/race proof и готовность terminal E2E harness/PTY prerequisite. Это подтверждает готовность harness, но не результат живого OMP journey;
- final 7.4 workspace integration/CI: run `35541403305` на repair head `3d853bc1582aebe4a3950cd85673a848767432c7` завершился успешно для install, build, typecheck и test; эта проверка не заменяет live 7.3.

- Свежий live J-аудит сохранён в
  `.work-state/run-lifecycle-acceptance-20260927/e2e/live-journey/final-acceptance-audit-20260928/`;
  R, ordinary-after-terminal, pending/no-duplicate и missing-input evidence —
  в `.work-state/run-lifecycle-acceptance-20260927/e2e/resume-live/`. Cleanup
  receipt находится в `e2e/resume-live/missing-input/cleanup-manifest.json`;
  raw transcripts, semantic logs, canonical snapshots и hashes сохранены.

- Для 8.1 E2E README отделяет JSON-сценарии и operator checklist от live prompt:
  зарегистрированные journeys запускаются в чистой сессии без `--scenario` и
  `--task`, с ручным вводом `/do-work`; setup также фиксирует model/ownership
  preflight и scratch-only scope boundaries.

Live evidence для 7.3 собрана по registered journeys и отдельному fresh-session
resume: terminal A/B/C, list-item selection без UUID fallback, A rework с
revision/rework_generation, сохранённое решение до dispatch, ordinary work после
terminal, `recovery_required` на missing required input и отсутствие duplicate
pending dispatch подтверждены отдельными transcript/semantic/canonical receipts.
Cleanup manifest подтверждает удаление только owner-owned temporary profile,
wrappers/helpers и plugin link; historical evidence, canonical history и
unrelated files сохранены. 7.3 live acceptance, 8.1 docs и 8.2 cleanup/
ownership audit больше не имеют открытого docs writer blocker.


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

**Статус:** live evidence пользовательских journeys и 7.4 integration/CI
собраны; 7.3 live acceptance подтверждена, а документационные 8.1 и cleanup/
ownership audit 8.2 завершены.

**Фактический результат:** независимая canonical UUID identity run; revision IDs сохраняют timestamp-UUID composite format; явные `new`, `resume` и `rework`; человекочитаемый выбор из списка или по названию без обязательного UUID; transactional migration/recovery/rework с сохранением evidence, откатом staged transaction до commit и forward repair после commit; backup остаётся evidence, а не механизмом rollback; canonical authority, ownership claims и capability scopes; перевод report/session/observability consumers на выбранный run/revision; готовые process/E2E harness seams.

**Live evidence:** A → B на одной ветке, C на другой, возврат к A через
показанный list item и rework завершены terminal; fresh-session resume прочитал
сохранённое решение до dispatch; missing required input вернул
`recovery_required`; terminal history не навязала workflow обычной задаче.
Receipts и canonical snapshots находятся в acceptance audit directories,
перечисленных в `Status`.

**Delivery closure:** cleanup manifest подтверждает, что временный profile,
scratch wrappers/helpers, diagnostic extensions и plugin link удалены владельцами
после сохранения hashes/receipts; production source, canonical history,
historical evidence и unrelated user files не затронуты.

**Включено:** ingress `/do-work` и `/team`, state resolution, session/run binding, существующие workflow tools/hooks и читатели состояния, защита от одновременно конфликтующего исполнения, миграция legacy state.

**Не включено:** изменение checkpoint permission, автономный scheduler, новая модель retries/budgets, миграция внутреннего CTO portfolio state на новый формат, programmatic continuation main agent и redesign viewer/graph model. Viewer не получает отдельный legacy fallback: он либо читает тот же canonical selector, либо возвращает явную недоступность/migration guidance.

**Итоговая проверка:** 7.3 live receipts и cleanup manifest сохранены в
acceptance directory; 8.1 examples/instructions и 8.2 cleanup/ownership audit
синхронизированы с ними. Автономия, scheduler, archive lifecycle и redesign
viewer не входят в закрытие и не объявляются реализованными.

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

Актуальный docs/acceptance cleanup inventory различает production/runtime,
регрессионные тесты, historical evidence и disposable live fixtures. Disposable
live material не считается заменённым runtime path и удаляется только владельцем
после сохранения receipts:

- `packages/core/src/engine/run-migration.ts` — production explicit importer и
  recovery path; сохраняется;
- `packages/core/test/smoke.test.ts` — постоянный regression/smoke test package
  boundary и canonical lifecycle guard; сохраняется;
- `vibe-report/` (включая исторический migration report и lifecycle UX evidence)
  и `.work-state/cto/run-lifecycle-01a0bacd/artifacts/` — evidence, не
  disposable scaffold; сохраняются;
- generated `packages/core/dist/engine/run-migration.*` — generated output, не
  tracked source для удаления в docs-only изменении;
- временный `packages/core/workflows/e2e-missing-input-acceptance-20260927.json`
  после missing-input receipt удалён владельцем, baseline `loadAllProfiles()` и
  baseline hashes восстановлены; raw fixture/source/hash evidence сохраняются
  отдельно;
- accidental project plugin link `e2e-missing-input-profile` удалён штатной
  командой согласно `e2e/resume-live/missing-input/plugin-link-cleanup.json`.

Оба класса временного материала закрыты owner receipts: core profile удалён с
восстановлением baseline `loadAllProfiles()`, а scratch OMP wrapper, argv
helper, diagnostic/profile extensions, load marker и fixture package удалены
с сохранением SHA-256 в
`e2e/resume-live/missing-input/cleanup-manifest.json`. Удаления выполнялись
только для этих owner-owned fixtures; historical evidence, canonical run state,
пользовательские и unrelated repository files сохранены. Старый
`.work-state/cto/run-lifecycle-01a0bacd/` не изменялся.

Свежие docs audit notes и финальная матрица сохранены в
`.work-state/run-lifecycle-acceptance-20260927/docs/docs-writer/`.
Сверка `docs/architecture/principles.md` с фактическими package boundaries не
обнаружила переноса ответственности, поэтому ownership map не менялась.

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
