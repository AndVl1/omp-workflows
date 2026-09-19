# Proposal

## Why

Наличие состояния ветки сейчас превращает новую задачу `/do-work` в продолжение старой либо блокирует её сообщением `state already exists`; переключение веток и сессий вынуждает пользователя вручную обслуживать `.work-state`. Нужен отдельный жизненный цикл запуска, чтобы исправить этот пользовательский контракт и создать устойчивую основу последующей работы над автономией, не отключая защиту переходов.

## What Changes

- Разделить идентичности worktree, ветки, host-сессии и запуска. На одной ветке допускается история независимых запусков.
- Различать `new`, `resume` и `rework`: новая задача получает собственное состояние; resume не сбрасывает прогресс; доработка сохраняет предыдущие результаты и переоткрывает только затронутую часть.
- **BREAKING:** существование состояния больше не означает автоматический resume. Обычный новый запрос запускает новую задачу; намерение продолжить/доработать выбирается явно, включая естественно-языковой запрос, с однозначным выбором run.
- Ввести общий session/run selector для workflow tools и hooks вместо независимых чтений `.active-feature` и branch-derived путей. Завершённая или чужая работа не должна блокировать обычную сессию.
- Защитить worktree от конкурирующего исполнения; не считать отсутствие host-сессии доказательством завершения workers. Поздние результаты связывать только с исходным запуском.
- Сохранить историю, артефакты и их provenance; перевести status, reports, visualization и observability на однозначную идентичность запуска.
- **BREAKING:** заменить branch-keyed layout и прежнюю форму `continuation` явным lifecycle API. Существующие данные переводятся через проверяемую однократную миграцию; все поставляемые потребители переходят вместе, без двух активных writers.
- Добавить recovery для устаревшего выбора запуска и прерванной миграции без ручного перемещения папок; повреждённые данные не выдавать за пустое состояние.

## Capabilities

### New Capabilities

- `run-lifecycle`: независимые запуски, выбор намерения и run, продолжение, доработка, история и терминальное освобождение сессии.
- `run-context-isolation`: единый scope hooks/tools, переключение веток/сессий, сериализация конфликтующего исполнения и изоляция поздних результатов.
- `run-state-migration`: безопасный переход существующих состояний и читателей на run-scoped модель, идемпотентное восстановление и сохранность истории.

### Modified Capabilities

Нет: на момент подготовки `openspec list --specs --json` возвращает пустой список. Существующее поведение изменяется, но базовых OpenSpec capabilities ещё нет.

## Impact

- Core: `engine/{types,state,run,durable,control-plane-contract,workflow-contract}.ts`, lifecycle-facing часть `engine/stage.ts`, `commands/{do-work,register,envelope}.ts`, регистрация tools/hooks в `src/index.ts`, gates, reports/visualize/observability и публичные экспорты.
- Потребители: fullstack и private internal registration/commands/tools; e2e harness и lifecycle regression scenarios. CTO storage и portfolio scheduler не переписываются, но проверяются shared workflow hooks и конфликт исполнения в том же worktree.
- API/данные: новые lifecycle requests и стабильный run selector; versioned state format, миграция legacy root/features; ручное редактирование canonical state не становится поддерживаемым UX.
- Документация: общий [roadmap](../../../docs/architecture/refactoring-roadmap.md), описание команды, контракта хранения и совместимости. Связанная Beads-задача `br-2up` описывает прежнее branch-scoped auto-resume; данный change уточняет её намерение, не закрепляя ошибку «одна ветка — одна задача».
- Зависимости: новый внешний runtime, БД или npm-пакет не требуются.
- Вне scope: изменение автономии/checkpoint policy, новый scheduler/retry engine, merge/deploy, полный frozen bundle, distributed execution и общий security overhaul. Эти направления не получают implementation tasks в этом change.
