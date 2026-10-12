# Proposal

## Why

Сдача артефактов, переходы этапов и восстановление после ошибок слишком зависят от ручных действий модели и оператора: корректный отказ превращается в тупик, а приёмка — в длительные неповторяемые LLM-прогоны. Нужны проверяемые программные контракты и быстрая детерминированная приёмка, которая воспроизводит ошибку и восстановление через реальные точки входа движка.

## What Changes

- Worker, assigned orchestrator и profile-declared tool сдают типизированный результат через общий tool/protocol; trusted binding имеет exact `producer.kind: worker|orchestrator|tool`, выводится из profile ownership, существующего `WorkIdentity`, current host/worker lineage или authenticated callback, а не из model authority fields. Модель передаёт тот же outputs-only envelope; engine валидирует содержимое, сохраняет workflow-артефакты и возвращает идемпотентную immutable квитанцию. Existing `product_prd_document` executable document renderer остаётся engine-owned trusted producer с тем же immutable publication path и без model submit/worker terminal. Native CTO tool acceptance обязателен через native committer; declared trusted tool не понижается до `STAGE_HOST_UNSUPPORTED`. Main-session `lecture_acquire` остаётся restricted и публикует через trusted core API, не произвольным файлом.
- Завершение worker, принятие результата, завершение этапа и завершение workflow становятся явно различимыми. Переход требует условий текущего профиля и актуальных approvals; результат прошлой итерации не разрешает новую.
- Штатный recovery различает незапуск, живого worker, потерю связи, подтверждённый сбой и неизвестный статус. При pinned OMP 18 canonical prepare создаёт queued replacement identity/retry linkage и bounded admission permit в существующем ledger; real-host `sendMessage` сообщает только authorized/queued/not-started, а running/terminal доказывает runtime. Default follow-up не подтверждает same-producer accepted repair/running, format-repair/producer-correction unsupported без truthful injected host, а invalid submission возвращает точные schema errors тому же caller. Исправимые ситуации восстанавливаются автоматически в пределах лимита; остальные получают точную причину и поддерживаемое продолжение без удаления state. Direct task API/internal executor не вводятся.
- Реальные циклы исправления сохраняют upstream-результаты: ошибка сдачи не повторяет реализацию; FAIL verification и замечания review запускают требуемую работу и зависимые проверки, а не синтетический успех.
- Ordinary и CTO используют общие инварианты, сохраняя собственные lifecycle и trusted authority. CTO root делегирует настроенному lead, lead — разрешённому roster; закрытие волны не заменяет явное завершение resident-режима.
- Основная приёмка — автоматические сценарии «сессия → выбор workflow → этап → ошибка → recovery → результат/переход» над реальным JS-кодом, без сети и LLM. Для новых контрактов и дефектов применяется test-first; bounded live OMP smoke проверяет только недоказуемые эмуляцией интеграционные границы.
- **BREAKING**: заменяем ручной producer-протокол сдачи для затронутых ordinary/CTO путей единым `StageProducerBinding`; `StageWorkerBinding` legacy alias не добавляется в unreleased draft. Все встроенные callers, включая фактические profile orchestrator stages и fullstack `lecture_acquire`, переводятся одновременно; старые артефакты остаются читаемыми, но не получают новых полномочий. Acceptance не подменяет worker terminal или approval; неподдерживаемая интеграция получает явную диагностику, не обход guards.

## Capabilities

### New Capabilities

- `stage-result-submission`: доверенная структурированная сдача, валидация, публикация и повторная доставка результата.
- `stage-execution-recovery`: завершение этапов, recovery, ограниченные циклы доработки и связанные terminal-переходы ordinary/CTO.
- `deterministic-workflow-acceptance`: автоматическая сценарная приёмка реального движка, fault injection, traceability и ограниченная native-проверка.

### Modified Capabilities

Нет изменений базовых lifecycle-требований. `openspec/specs/` пока пуст; исходный контракт находится в `../run-lifecycle/specs/{run-lifecycle,run-context-isolation,run-state-migration}/spec.md`. Этот change дополняет его, не копирует и не меняет `new/resume/rework`, ownership или правила миграции. Синхронизация/архивирование `run-lifecycle` не входит в эту работу; перед будущей синхронизацией данного change необходимо учитывать этот базовый контракт, а не публиковать противоречащую ему замену.

## Impact

- `packages/core`: registered tools/hooks, durable dispatch, публикация артефактов, existing `product_prd_document` renderer, stage/loop transitions, session controller, native CTO authority и профили.
- `packages/fullstack` и `packages/omp-workflows-internal`: host adapters, registered команды, инструкции producers/leads, actual profile orchestrator callers, fullstack `src/tools/lecture-acquire.ts` и передача событий worker.
- Существующие `node:test`/`tsx` suites и CI: переиспользуем реальные registrations/controllers и isolated temp stores; не создаём отдельный симулятор движка.
- `packages/e2e`: только ограниченные интеграционные сценарии и их evidence; ремонт процесса harness не включён.
- Включены [#73](https://github.com/AndVl1/omp-workflows/issues/73) (реальный debug-cycle FAIL→retry) и [#76](https://github.com/AndVl1/omp-workflows/issues/76) (preflight refusal не должен оставлять pending dispatch).
- Уже внесённые изменения PR #72 оцениваются по новым критериям: существующее поведение сохраняется при доказательстве, отсутствие end-to-end evidence не маскируется зелёными component tests. Связанные Beads и границы доказательств перечислены в design.
- Не входят: исправление внешнего Android bundle [#71](https://github.com/AndVl1/omp-workflows/issues/71), ремонт harness/PR #70, исторического CTO-run, глобальный рефакторинг, новый UI, публикация релиза или гарантированное восстановление произвольно повреждённых данных. Существующие QA-сессии не возобновляются.
